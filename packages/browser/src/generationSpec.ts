import type {Abi, EventProcessor, GenerationContext, IndexingSource} from '@etherfold/core';
import type {WritableStateStore} from '@etherfold/state-store';
import type {BrowserGenerationSpec, EntityEventProcessorLike} from './IndexerState.js';
import {moduleProcessorIdentity} from './moduleIdentity.js';
import {arriveFromBundle, refuseAnIdentityBesideABundle, type ProcessorBundleSource} from './processorBundle.js';
import type {PublicationSnapshot} from './publication.js';
import {withClaimPatience} from './utils/claim.js';

/**
 * THE TWO FACTORIES AS THE CONTAINER TAKES THEM, with the read handle it answers
 * through: ONE translation for every host.
 *
 * The main-thread host (`createIndexerState`) and the worker hosts' driver
 * (`host/serve.ts`) used to carry a copy each, and the copies were already
 * agreeing by inspection rather than by construction. A generation a host builds
 * is the same thing wherever the host runs (ADR-0082), so it is built here: the
 * bundle arrives first, the snapshot a publication names is chosen by the identity
 * the generation will be registered under, the claim is bounded, the processor is
 * configured, and the fold is named.
 *
 * What differs between hosts is handed IN: where a host records the store each
 * generation folds into (`recordState`), and which snapshot, if any, `createState`
 * is handed (`snapshotFor`, from `createPublishedStart`).
 */
export function generationSpecOf<ABI extends Abi, ProcessResultType, ProcessorConfig>(build: {
	createState: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createState'];
	createProcessor: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createProcessor'];
	processorConfig?: ProcessorConfig;
	arrival?: {processorIdentity?: string; processorBundle?: ProcessorBundleSource};
	/** PER GENERATION; `undefined` is what the container reads as "the stream it already has". */
	source?: IndexingSource<ABI>;
	/** The host's patience for the writer claim, in seconds. See `utils/claim.ts`. */
	claimWithinSeconds?: number;
	/** Where the host keeps the store this generation folds into, keyed on its registered identity. */
	recordState(id: {stream: string; processor: string}, state: WritableStateStore): void;
	/** The snapshot a publication names for this generation, or none. See `PublishedStart.snapshotFor`. */
	snapshotFor?: (generation: {stream: string; processor: string | undefined}) => PublicationSnapshot | undefined;
}) {
	const processorIdentity = build.arrival?.processorIdentity;
	const processorBundle = build.arrival?.processorBundle;
	refuseAnIdentityBesideABundle(build.arrival);
	// WHAT NAMES THIS GENERATION, filled in by `createProcessor` below where the
	// arrival supplied nothing.
	//
	// THE READ ORDER IS THE CONTRACT and it is `Indexer.add`'s own: it builds the
	// state, builds the processor, and only THEN resolves the identity -- which is
	// what makes a MODULE arrival expressible at all, since a fold with no bytes
	// cannot be named before the object exists (`moduleProcessorIdentity`). So this
	// spec must reach the container WHOLE: spreading it into another object literal
	// would copy this field at spread time, when it is still `undefined`, and the
	// generation would quietly fall back to the declared hash. That is why a
	// per-generation `source` is a parameter here rather than a property a caller
	// merges in.
	const spec = {
		createState: async (context: GenerationContext) => {
			// THE BUNDLE ARRIVES FIRST, before any state is built -- inside the worker,
			// where the host is one: a refused bundle (`ProcessorBundleRefusedError`)
			// then claims no store and folds nothing.
			const bundle = processorBundle ? await arriveFromBundle(processorBundle) : undefined;
			// THE ENTRY FOR THIS GENERATION, chosen by the identity it WILL be registered
			// under: the bundle's bytes, or an identity the arrival handed over. A module
			// arrival has none yet (it is derived from the fold, built after this), so it
			// is refused by name rather than matched on half its generation.
			const published = build.snapshotFor?.({
				stream: context.stream,
				processor: bundle?.identity ?? processorIdentity,
			});
			return withClaimPatience(build.claimWithinSeconds, (patience) =>
				build.createState(context, patience, bundle, published),
			);
		},
		createProcessor: async (state: unknown, context: GenerationContext) => {
			// The SAME arrival the state waited on (one load per source), so the bytes this
			// fold runs are the bytes the identity below was computed over.
			const bundle = processorBundle ? await arriveFromBundle(processorBundle) : undefined;
			const built = await build.createProcessor(state as WritableStateStore, context, bundle);
			if (built.configure && build.processorConfig) {
				built.configure(build.processorConfig);
			}
			// THE MODULE ARRIVAL'S OWN DERIVATION, where no other arrival named this
			// fold: a dev server hands a tab -- or the worker it started -- a module OBJECT
			// and there are no bytes to hash, so the identity comes from the handler
			// sources (ADR-0086, and `moduleProcessorIdentity` for what that survives and
			// why it is sound in the only runtime it can happen in). Nothing an application
			// passed reaches it.
			//
			// The FIRST build wins, because that is what the container does with the
			// generation itself: naming a generation it already holds RESOLVES to the one
			// it is folding rather than adding a second engine over it.
			//
			// A BUNDLE names its fold by its own bytes (ADR-0095), and nothing else may.
			spec.processorIdentity ??= bundle?.identity ?? processorIdentity ?? moduleProcessorIdentity(built);
			// THE STATE THIS GENERATION FOLDS INTO, recorded HERE and not in `createState`,
			// because this is the first moment both halves of the name exist. Keyed on the
			// SAME value the container registers this generation under, resolved a line
			// above: a store recorded under a name the registry did not file is a read the
			// host cannot answer and a prune it never runs.
			build.recordState({stream: context.stream, processor: spec.processorIdentity}, state as WritableStateStore);
			return built;
		},
		stateOf: (built: EventProcessor<ABI, ProcessResultType>) =>
			(built as EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>).state,
		// Handed STRAIGHT to the container, which registers the generation under it and
		// never asks where it came from. `undefined` here means only that no arrival
		// named this fold BEFORE it was built: `createProcessor` above fills the field in
		// from the module itself, and the container reads it afterwards.
		processorIdentity,
		// PER GENERATION, and a parameter rather than something a caller merges into
		// the returned object: see the note above on why this spec must not be spread.
		source: build.source,
	};
	return spec;
}
