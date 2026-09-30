import type {GenerationContext} from '@etherfold/core';
import {
	openForReading,
	openForWriting,
	openSnapshotAware,
	type EntityDeclaration,
	type StateStore,
	type StateStoreBackend,
	type WritableStateStore,
} from '@etherfold/state-store';
import {logs} from 'named-logs';
import {openAndBootstrap, type BootstrapOutcome} from './snapshot.js';
import {EntityStateView} from './view.js';

const logger = logs('@etherfold/processor-entities');

/*
 * THE PARAMETER TYPES THE BROWSER HOST HANDS ITS FACTORIES, declared STRUCTURALLY.
 *
 * They are `@etherfold/browser`'s (`ClaimPatience`, `InstantiatedProcessorBundle`,
 * `PublicationSnapshot`, `ReaderState`), and this package must not import that one:
 * `@etherfold/browser` devDepends on this package, so an import back would be a
 * dependency cycle. Each is narrowed to the fields the factories below READ, which
 * is what makes the browser's own types assignable to them.
 */

/** The host's patience for the writer claim: `ClaimPatience` in `@etherfold/browser`. */
export type StateClaimPatience = {
	/** Aborts once the host's patience for the CLAIM has run out. Handed to `openForWriting` and nothing else. */
	readonly signal: AbortSignal;
};

/** A published bundle that arrived, as far as a store needs it: `InstantiatedProcessorBundle` in `@etherfold/browser`. */
export type ArrivedProcessorBundle = {
	/** The authoring object the bundle's bytes made. Its `entities` are what the store is declared from. */
	readonly processor: unknown;
};

/** The snapshot a publication index names for a generation: `PublicationSnapshot` in `@etherfold/browser`. */
export type PublishedSnapshotForState = {
	/** `openAndBootstrap`'s locations. */
	readonly locations: readonly string[];
	/** `openAndBootstrap`'s `processor`: the identity the generation is registered under. */
	readonly processor: string;
	/** `openAndBootstrap`'s `replaceLocal`: `true` when the host abandoned a catch-up (ADR-0096). */
	readonly replaceLocal?: boolean;
};

/** What a tab that does not index is built from: `ReaderState` in `@etherfold/browser`, over an entity store. */
export type EntityReaderState = {
	/** The store, opened for READING: a `StateStore`, which names no mutating verb. */
	readonly store: StateStore;
	/** The read handle over it, the same kind a writer's processor publishes on `state`. */
	readonly state: EntityStateView;
};

/** The two factories, as a host's spec takes them. */
export type StateFactories = {
	/**
	 * THE WRITER: the store, started from the published snapshot when the host
	 * hands one (`openAndBootstrap`, forwarding `replaceLocal`), and otherwise
	 * opened snapshot-aware, then CLAIMED (`openForWriting`) with the host's signal.
	 */
	readonly createState: (
		context: GenerationContext,
		patience: StateClaimPatience,
		bundle?: ArrivedProcessorBundle,
		published?: PublishedSnapshotForState,
	) => Promise<WritableStateStore>;
	/**
	 * THE READER: the SAME store, opened snapshot-aware and then for READING, with
	 * its `EntityStateView`. No claim, no bootstrap, nothing fetched.
	 */
	readonly openState: (context: GenerationContext, bundle?: ArrivedProcessorBundle) => Promise<EntityReaderState>;
};

export type StateFactoriesOptions = {
	/**
	 * THE ONE STORE CONSTRUCTOR both factories open: the storage a generation's
	 * state lives in, built and not yet claimed. Handed the declarations to build it
	 * with (the bundle's own, or `entities`), so the store is always declared from
	 * the fold that writes it.
	 *
	 * ```ts
	 * open: (context, entities) => createBrowserStateStore(entities, {databaseName: `app-${context.stream}`}),
	 * ```
	 *
	 * Called ONCE per factory call, by the writer and by the reader alike, which is
	 * the whole point: the reader opens the database the leader writes because
	 * there is only one place that names it.
	 */
	readonly open: (
		context: GenerationContext,
		entities: readonly EntityDeclaration[],
	) => StateStoreBackend | Promise<StateStoreBackend>;
	/**
	 * The declarations, for a processor IMPORTED as a module. Unused when the host
	 * hands a published bundle, whose own processor's `entities` are what the fold
	 * that writes the store declares.
	 */
	readonly entities?: readonly EntityDeclaration[];
	/** `openAndBootstrap`'s `finalityDepth`: a snapshot inside this reorg window is declined. */
	readonly finalityDepth?: number;
	/** `openAndBootstrap`'s `fetch`: injectable for tests and for a host with its own retry policy. */
	readonly fetch?: typeof globalThis.fetch;
	/**
	 * Told what the bootstrap did, each time the writer is handed a snapshot: a
	 * refusal is DATA (`{status: 'not-bootstrapped', reason}`), so an app that
	 * renders or logs it does so here.
	 *
	 * An observer and nothing more: an error it throws is logged and swallowed, so
	 * a bug in the app's rendering never stops the writer from claiming a store
	 * that installed correctly.
	 */
	readonly onBootstrap?: (outcome: BootstrapOutcome, context: GenerationContext) => void;
};

/**
 * ONE STORE CONSTRUCTOR, BOTH SEATS OF THE TAB ELECTION (ADR-0097): the writer
 * factory and the reader factory, derived from one `open`, so the two can never
 * name different databases.
 *
 * ```ts
 * hostIndexerInThisWorker({
 *   ...stateFactoriesFrom({
 *     open: (context, entities) => createBrowserStateStore(entities, {databaseName: `app-${context.stream}`}),
 *     entities: processor.entities,
 *   }),
 *   createProcessor: (state) => fromEntityProcessor(processor)(state),
 *   tabElection: {name: 'my-app'},
 * });
 * ```
 *
 * Two hand-written factories are a correctness hazard and not only repetition:
 * the election is correct only while the reader opens the SAME database the
 * leader writes, and a `databaseName` changed in one of them leaves a reader
 * answering from an empty store while looking healthy.
 *
 * It changes nothing about either factory's contract, which is why it is a
 * helper and not a host change: the writer returns the `WritableStateStore`
 * `openForWriting` gives (ADR-0077) and the reader the read-only `StateStore`
 * `openForReading` gives, so a reader built this way cannot write, by type. The
 * install stays the app's (ADR-0096): the writer runs `openAndBootstrap` with
 * the `published` snapshot the host hands it, and the reader never downloads or
 * installs one. The claim signal bounds the CLAIM alone, never the download.
 *
 * The reader is opened SNAPSHOT-AWARE before it is opened for reading, so a
 * reader of a snapshot-seeded store keeps the floor the leader's install
 * recorded and refuses an as-of read below it, as the writer does. Opening
 * snapshot-aware MIGRATES the store (`openSnapshotAware` calls `migrate()`), so a
 * reader runs the backend's idempotent migration too: nothing for the browser
 * store, whose constructor already migrated, and `CREATE ... IF NOT EXISTS` DDL
 * on a SQLite one, which a read-only connection would refuse. Give a reader a
 * connection that may run it, or open it by hand (`openForReading` over the raw
 * backend), accepting that it then reads without the snapshot floor.
 */
export function stateFactoriesFrom(options: StateFactoriesOptions): StateFactories {
	const entitiesOf = (bundle: ArrivedProcessorBundle | undefined): readonly EntityDeclaration[] => {
		if (bundle) {
			const declared = (bundle.processor as {entities?: unknown} | null | undefined)?.entities;
			if (!Array.isArray(declared)) {
				throw new Error(
					`the published bundle's processor declares no \`entities\` array, so there is nothing to declare its ` +
						`store from. A bundle for an entity processor exports the authoring object, with its entities.`,
				);
			}
			return declared as readonly EntityDeclaration[];
		}
		if (!options.entities) {
			throw new Error(
				`no declarations to open the store with: the host handed no published bundle, and \`entities\` was not ` +
					`given. Pass \`entities: processor.entities\` for a processor imported as a module.`,
			);
		}
		return options.entities;
	};

	return {
		async createState(context, patience, bundle, published) {
			const backend = await options.open(context, entitiesOf(bundle));
			let store: StateStoreBackend;
			if (published) {
				const opened = await openAndBootstrap(backend, published.locations, {
					processor: published.processor,
					replaceLocal: published.replaceLocal,
					...(options.finalityDepth !== undefined ? {finalityDepth: options.finalityDepth} : {}),
					...(options.fetch ? {fetch: options.fetch} : {}),
				});
				try {
					options.onBootstrap?.(opened.outcome, context);
				} catch (error) {
					logger.error(`onBootstrap threw; the store is claimed regardless`, error);
				}
				store = opened.store;
			} else {
				// snapshot-aware with no snapshot to fetch: it recovers a floor an earlier
				// install recorded, and passes straight through a store nobody seeded
				store = await openSnapshotAware(backend);
			}
			// the signal bounds the CLAIM and nothing else (not the download above)
			return openForWriting(store, {signal: patience.signal});
		},
		async openState(context, bundle) {
			const store = openForReading(await openSnapshotAware(await options.open(context, entitiesOf(bundle))));
			return {store, state: new EntityStateView(store)};
		},
	};
}
