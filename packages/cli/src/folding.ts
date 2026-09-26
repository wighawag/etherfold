import {
	SERVER_GENERATION_CAPS,
	generationDigestOf,
	openReceivingIndexer,
	type Abi,
	type EventProcessor,
	type GenerationFolding,
	type GenerationId,
	type GenerationRecord,
	type IndexingSource,
	type PromotionConfig,
	type ProvidedStreamConfig,
	type ReceivedGenerationSpec,
	type ReceivingIndexer,
	type ReceivingIndexerOptions,
	type StreamWriter,
} from '@etherfold/core';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {streamConfigFromEnv, type EnvRecord} from '@etherfold/fetcher-host';
import {
	localPosition,
	openForWriting,
	type EntityDeclaration,
	type EntityProcessor,
	type StateStore,
	type WritableStateStore,
} from '@etherfold/processor-entities';
import type {StatusReport, WaitingReport} from '@etherfold/server';
// TYPE ONLY, so that naming the store this module builds costs no eager import of
// libSQL: the value arrives through the dynamic import below.
import type {VersionedStateStore as SQLiteStateStore} from '@etherfold/state-store-sqlite';
import {
	loadContracts,
	loadProcessorArtifact,
	processorArtifactIdentity,
	resolveSource,
	type ProcessorArrival,
	type ProcessorModule,
} from '@etherfold/utils';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {readStatusReport} from './cursorReport.js';
import {reorgRecorderFor} from './reorgCounters.js';
import type {ExplicitSource, SourceOrigin, StoreTarget} from './types.js';

const logger = logs('etherfold');

// ---------------------------------------------------------------------------------------------------
// THE FOLDING ASSEMBLY EVERY COMMAND THAT OWNS A DATABASE SHARES
// ---------------------------------------------------------------------------------------------------
// Three of the five commands fold: `run` and `build` fetch what they fold,
// `index` receives it. What differs between them is where the batches come
// FROM -- a `LogFetcher` on this side of a direct in-process wire, or a sender
// on the other side of an HTTP one -- and what is IDENTICAL is everything below
// the stream-builder: one stream configuration, one database handle, one
// GENERATION CONTAINER over it, and the two ports that write what a fold
// concluded. So it lives here rather than in any one command's module, which is
// the file-level form of "no component is implemented twice".
//
// ## What the three commands hold is a CONTAINER, not a receiver
//
// They used to hold a bare `StreamBuilder` over one un-namespaced store, which
// meant a changed context reached `processor.clear()`: the state the deployment
// answered from was DISCARDED and it served progressively less until it had
// caught up. `ReceivingIndexer` (`@etherfold/core`) is the chain-free generation
// container that removes that outage, and this is where the CLI supplies the
// three things that container deliberately cannot have, because
// `@etherfold/core` knows no database:
//
//   the REGISTRY SUBSTRATE  rows in `_generations` / `_generation_slots`
//                           (`generationRegistryPortOnSQL`, ADR-0054), so a
//                           restart comes back holding what it held and
//                           pointing where it last pointed;
//   the STATE NAMESPACE     a generation's state is a TABLE-NAME NAMESPACE
//                           inside the one database (ADR-0053), named from the
//                           generation identity, which is computable BEFORE the
//                           processor exists;
//   the STREAM's two ends   `emissionAppenderFor` to store what the WRITER of a
//                           stream folded (ADR-0052) and
//                           `storedEmissionReplaySource` to re-fold it, which is
//                           what makes a processor upgrade cost a local scan.
//
// The commands then differ in EXECUTION and in nothing else: `run` follows the
// tip and serves, `build` stops at the tip and exits, `index` is fed over the
// wire. NONE of them holds a fixed number of generations -- a re-run `build` with
// changed processor bytes registers a successor beside the canonical generation
// just as a restarted `run` does -- so their databases are comparable generation
// for generation, which is what `packages/cli/test/equivalence.test.ts` asserts
// over one fixture chain.
// ---------------------------------------------------------------------------------------------------

/**
 * The stream configuration every command indexes under, DERIVED ONCE from the
 * environment and handed to both halves.
 *
 * The RESOLVED object is hashed into the wire identity, so a sending
 * `LogFetcher` and a receiving `StreamBuilder` must reach the same `finality`
 * from the same input. Its resolved form is also what the entity store's
 * retention floor is checked against, which is why nothing here writes a
 * finality number of its own.
 *
 * ## Why this is a function of the environment and not a constant
 *
 * It was `const STREAM_CONFIG = {}`, on the reasoning that an empty config makes
 * both halves take the same default. That held only while nothing else fed the
 * config. The fetcher host reads the stream settings from the environment
 * (`STREAM_FINALITY`) and merged the caller's
 * override OVER it -- and a spread of `{}` cannot remove a key the
 * environment has already put there. So the sender resolved `STREAM_FINALITY` and the receiver resolved
 * the default, the two digests could never match, and `run` and `build` refused
 * to start on any host that set the documented variable.
 *
 * Deriving here fixes it in the direction that keeps the variable WORKING: both
 * halves honour it, rather than agreeing by both ignoring it, which would have
 * satisfied the hash while silently discarding a documented setting (and this
 * repo's rule is that nothing is accepted and ignored). It also means the
 * combined shape and the split shape read one environment the same way.
 */
export function streamConfigFor(env: EnvRecord): ProvidedStreamConfig {
	return streamConfigFromEnv(env);
}

/**
 * Turn a source ORIGIN a chain-free command resolved into the source itself.
 *
 * Two arms and no third, which is the type talking: the module route is the only
 * one that can cost an `eth_chainId` call, so a command that makes no chain call
 * has already refused it by name (`requireExplicitSource`). Both `fetch` (no
 * processor module to read a source out of) and `index` (no node to ask) land
 * here, for different reasons and on the same two arms.
 */
export async function openExplicitSource<ABI extends Abi>(origin: ExplicitSource<ABI>): Promise<IndexingSource<ABI>> {
	switch (origin.from) {
		case 'deployments':
			return loadContracts<ABI>(origin.folder);
		case 'INDEXING_SOURCE':
			return origin.source;
	}
}

/**
 * Turn a resolved source ORIGIN into the source itself, all three arms.
 *
 * The origin was decided from the flags and the environment alone; this is where
 * the side effect it names actually happens, and the three arms are deliberately
 * not equivalent. Both explicit arms are CHAIN-FREE, which is what lets `index`
 * -- the receiving half, which makes no chain call at all -- resolve a source as
 * a first-class case rather than as a special case bolted on. The module arm is
 * the only one that may cost an `eth_chainId` call, and it is the only one a
 * chain-free caller is refused (`requireExplicitSource`).
 *
 * It lives HERE, beside the fold it feeds, because it is run TWICE against one
 * deployment: once when the process assembles (`prepareIndexing`), and again
 * whenever that process is asked to RE-READ its configuration
 * (`reconfigure.ts`). A source change and a processor change arrive together, so
 * a re-read that reloaded the module and kept the old source would half-apply
 * the author's intent.
 */
export async function openIndexingSource<ABI extends Abi, ProcessResultType>(
	origin: SourceOrigin<ABI>,
	processorModule: ProcessorModule<ABI, ProcessResultType>,
	provider: EIP1193ProviderWithoutEvents,
): Promise<IndexingSource<ABI>> {
	const source =
		origin.from === 'processor-module'
			? await resolveSource<ABI, ProcessResultType>(processorModule, provider as never)
			: await openExplicitSource<ABI>(origin);
	if (!source || !source.contracts) {
		throw new Error(
			`contracts data not found in the processor module, it needs to be provided either as exported field named ` +
				`"contractsData" or as field "contractsDataPerChain" indexed by chainID`,
		);
	}
	return source;
}

/**
 * A fold against a database that carries none of the fixed tables, where the
 * operator has said something else migrates it.
 *
 * REFUSED at start-up rather than discovered on the first batch, because a fold
 * now REGISTERS its generation before it reads or writes anything: the registry
 * and the canonical pointer are ROWS (ADR-0054), so a database without them is
 * one this process cannot hold a generation in at all. Discovered lazily it
 * would be a process reporting itself healthy while every cycle failed; named
 * here it is a refusal that says which two things would fix it.
 *
 * `--no-auto-setup` keeps its exact meaning and is deliberately not overridden:
 * it says somebody else owns this database's migrations, and applying the schema
 * anyway would be this process deciding otherwise on their behalf.
 */
function refuseUnmigratedDatabase(db: string): never {
	throw new Error(
		`${db} does not carry the fixed-table schema, and --no-auto-setup says something else migrates it. This ` +
			`command folds under a GENERATION, and a generation is REGISTERED before anything is read or written -- as ` +
			`rows in the registry and the canonical pointer (ADR-0053/ADR-0054) -- so there is nothing here to register ` +
			`it in. Migrate the database first (\`POST /admin/setup\` on a server that already answers it, or ` +
			`\`applySchema\` from @etherfold/server), or drop --no-auto-setup and let this process apply the schema it ` +
			`needs.`,
	);
}

/**
 * Open the ONE database handle this command folds into, with the fixed tables in
 * place.
 *
 * Separate from `openFolding` below, and BEFORE it, because the order is part of
 * the contract: a database this command cannot open, or one it may not migrate,
 * is refused before the source is resolved -- which is the first thing that can
 * touch the chain. What it can no longer come before is the STORE, because a
 * generation's tables are named from the stream digest and that is a function of
 * the source (ADR-0053).
 *
 * The handle is returned rather than kept, because a command that also serves
 * hands this SAME object to the server (`platforms/nodejs`'s `StartOptions.db`
 * takes one): the store and the read surface then see one database rather than
 * two connections with two views of it -- against `:memory:` they would not even
 * be the same database.
 *
 * The imports are dynamic so that a command which never opens a database does
 * not pay for libSQL, matching how `serve` keeps the server's dependency tree
 * off `build`.
 */
export async function openFoldingDatabase(
	target: StoreTarget,
	options: {
		createDB?: (url: string) => RemoteSQL;
		/**
		 * Create the fixed tables (`_meta`, `_emissions`, the generation registry) if
		 * they are absent.
		 *
		 * `build` passes `true` unconditionally: the one-shot binds no port, so nothing
		 * else in that process ever would, and a database it emitted is a publishable
		 * ARTIFACT that must carry its schema version, the reverts it concluded and the
		 * generation it folded under. `run` and `index` pass what `--no-auto-setup`
		 * said, and a `false` against a database that has not been migrated is a
		 * refusal (see `refuseUnmigratedDatabase`) rather than a slow failure.
		 */
		applyFixedSchema: boolean;
	},
): Promise<RemoteSQL> {
	const [{createNodeDB, ensureFixedSchema}, {readSchemaState}] = await Promise.all([
		import('@etherfold/platform-nodejs'),
		import('@etherfold/server'),
	]);
	const handle = options.createDB ? options.createDB(target.db) : createNodeDB(target.db);
	if (options.applyFixedSchema) {
		await ensureFixedSchema(handle, target.db);
	} else if (!(await readSchemaState(handle)).applied) {
		refuseUnmigratedDatabase(target.db);
	}
	return handle;
}

/**
 * ONE DECLARED PROCESSOR, as this deployment's database folds it: the state its
 * generations land in, the identity it is FILED under, and the two factories a
 * container builds a fold from.
 *
 * Built by `foldPartsFor` and named as a type because it is assembled TWICE over
 * one running deployment: once by `openFolding` for the fold a process comes up
 * with, and again by a RE-READ for the processor that has just been rebuilt
 * (`reconfigure.ts`). The successor has to land in the same database, under the
 * same namespacing convention and with the same retention and finality, or it
 * would not be the same deployment reconfigured -- so the assembly exists once
 * and both callers ask for it rather than each spelling it out.
 */
export type FoldParts<ABI extends Abi, ProcessResultType = unknown> = {
	/**
	 * ONE generation's state, by identity: its entity tables, `_blocks` and
	 * `_cursor` under the namespace that identity names (ADR-0053). NOT claimed --
	 * the claim is taken by `generation.createState`, and this bare form is what a
	 * DROP is performed through.
	 */
	stateFor(id: GenerationId): SQLiteStateStore;
	/**
	 * The processor half of the generation identity this declaration WILL have,
	 * computable before the processor exists (ADR-0053).
	 *
	 * WHERE IT CAME FROM is the ARRIVAL's business and not this module's (ADR-0086):
	 * a deployment's `--processor` path names a self-contained BUNDLE, and the
	 * SHA-256 of those bytes -- which no author can state or fail to state -- is what
	 * the arrival hands over and what this holds.
	 *
	 * Renamed from `versionHash`, which described the author-declared value this
	 * replaced: a field whose name says DECLARED VERSION while it holds a hash of
	 * bytes is the kind of quiet re-meaning that costs a reader an afternoon.
	 *
	 * It is a string the registry compares for equality and renders into messages.
	 * NOTHING reads it to work out which arrival produced it, which is what lets an
	 * arrival derive one however it must.
	 */
	processorIdentity: string;
	/**
	 * The two factories, in ADR-0043's order: state FIRST, then the fold over it --
	 * plus the IDENTITY they are both built under, stated rather than left to be asked
	 * for.
	 *
	 * The identity is on the SPEC because the container is HANDED one and never asks
	 * where it came from (ADR-0086), and there is nothing left for it to ask: a fold
	 * cannot name itself. So it is `processorIdentity` above, restated nowhere: ONE
	 * value reaching the table namespace, the fold and the registry record, which is
	 * what stops any two of them spelling it differently.
	 */
	generation: Pick<
		ReceivedGenerationSpec<ABI, ProcessResultType, WritableStateStore>,
		'createState' | 'createProcessor' | 'processorIdentity' | 'bundle'
	>;
};

/**
 * Build the fold parts above for ONE declared processor over ONE database.
 *
 * ## Why the state factory can name its namespace up front
 *
 * A generation is `{stream digest, fold identity}`, the digest is a function of
 * the source and the stream config, and the fold half is a value this function
 * ALREADY HOLDS -- so the namespace is computable BEFORE the processor exists
 * (ADR-0053) and the state-then-processor build order (ADR-0043) still holds.
 *
 * It holds it because the ARRIVAL derived it (ADR-0086) and handed it in as
 * `identity`, and it is passed unchanged to the namespace, to the fold and to the
 * registry -- so the identity the container OBSERVES afterwards is the one the
 * tables were named from.
 *
 * The imports are dynamic so that a command which never opens a database does not
 * pay for libSQL, matching how `serve` keeps the server's dependency tree off
 * `build`.
 */
export async function foldPartsFor<ABI extends Abi, ProcessResultType>(
	declared: EntityProcessor<ABI, any>,
	target: StoreTarget,
	db: RemoteSQL,
	/** The stream's own resolved finality, which the retention window is validated against. */
	finalityDepth: number,
	/**
	 * What the ARRIVAL produced: the bundle this deployment was configured with and the
	 * SHA-256 of it, which is the fold's identity (ADR-0086).
	 *
	 * REQUIRED, because nothing else can name this fold: the author-declared version
	 * it used to fall back to is gone, and a processor built from bytes cannot state
	 * what it is. And the BYTES are required with the name, because registering the
	 * generation stores them beside its state (ADR-0092). A caller resolves both
	 * through `openProcessorArrival` (`@etherfold/utils`) and REFUSES a path that
	 * produced none (`requireArrivedBundle`).
	 */
	arrived: ArrivedBundle,
): Promise<FoldParts<ABI, ProcessResultType>> {
	const [{EntityEventProcessor}, {VersionedStateStore}] = await Promise.all([
		import('@etherfold/processor-entities'),
		import('@etherfold/state-store-sqlite'),
	]);

	/**
	 * ONE generation's state: the entity tables, `_blocks` and `_cursor` under the
	 * namespace that generation's identity names, in the database every other
	 * generation of this name also lives in (ADR-0053).
	 *
	 * The finality depth is the stream's own, resolved by the caller from
	 * `streamConfigFor`: a retention window is validated against the depth a reorg
	 * can actually reach, and a number written here instead would be a second
	 * opinion about it. It is also the FLOOR a `revert-only` store prunes at
	 * (`retentionFloor`), which is why stating it matters to a deployment that set no
	 * window at all.
	 *
	 * Nothing here prunes, and nothing on the fold's path does: pruning is a call a
	 * host SCHEDULES (ADR-0022), and one inside the index loop would stall whichever
	 * block crossed the threshold. This command set schedules it between cycles and,
	 * on the one-shot, before it exits -- see `pruning.ts`.
	 */
	const stateFor = (id: GenerationId): SQLiteStateStore =>
		new VersionedStateStore(db, declared.entities, {
			tableNamespace: generationDigestOf(id),
			retention: target.retention,
			finalityDepth,
		});
	// THE ARRIVAL'S, and nothing else: asking a processor built from bytes to state
	// its own version is the question ADR-0086 says it cannot answer.
	const processorIdentity = arrived.identity;

	return {
		stateFor,
		processorIdentity,
		generation: {
			// STATED, so the container takes it rather than asking the fold for it: the
			// registry record, the table namespace above and the processor below are then one
			// value handed to three places (ADR-0086).
			processorIdentity,
			// ...and the BYTES that value is the hash of, which the container stores with the
			// registration (ADR-0092). Carried beside the identity from the one arrival that
			// produced both, so the code a generation keeps is the code that names it.
			bundle: arrived.bundle,
			// CLAIMED here, which is the ONE place this process takes the store: folding is
			// writing, and the ability to mutate is obtained by claiming (ADR-0077). A
			// second process pointed at this database takes the claim and this one's next
			// mutation is refused whole rather than half-applied (ADR-0075).
			createState: (generation) => openForWriting(stateFor({stream: generation.stream, processor: processorIdentity})),
			// The CLI intentionally constructs the processor with NO factory argument (the
			// server passes its folder); see MEDIUM-3.
			//
			// The fold computes NO identity of its own (ADR-0086), which is what keeps ONE
			// answer to "which generation is this" everywhere below: the container registers
			// what this spec states, the receiver advertises it on the feed and the stored
			// cursor records it, so the table namespace named above from `processorIdentity`
			// and the identity the registry files cannot be two different values.
			createProcessor: (state) =>
				new EntityEventProcessor<ABI, any>(state, declared, {
					finalityDepth,
				}) as unknown as EventProcessor<ABI, ProcessResultType>,
		},
	};
}

/**
 * WHAT A NODE DEPLOYMENT'S ARRIVAL PRODUCED: the bundle's octets, and the identity
 * that is their hash (ADR-0086).
 *
 * ONE value rather than two parameters, because the two are one fact seen twice: a
 * generation is NAMED by the identity and KEEPS the bytes (ADR-0092), and a pair a
 * caller could assemble from two sources is a pair that can disagree -- a rebuild
 * landing between a hash and a second read would file one bundle's code under
 * another's name.
 */
export type ArrivedBundle = {
	/** `sha256:<hex>` over `bundle`: the processor half of the generation identity. */
	readonly identity: string;
	/** The octets themselves, which the registration stores beside the generation's state. */
	readonly bundle: Uint8Array;
};

/**
 * THE BUNDLE THIS ARRIVAL READ, with its identity -- or a refusal naming the path
 * that produced none.
 *
 * A processor's identity is derived from what it IS (ADR-0086): a `--processor`
 * path names a self-contained BUNDLE and the SHA-256 of those octets is the
 * generation's name, and on this runtime those same octets are what the generation
 * KEEPS (ADR-0092). A path that resolves through the MODULE SYSTEM instead has no
 * bytes that describe it, so such a deployment has neither a name for its fold nor
 * code it could store for it.
 *
 * So it is REFUSED, here, before a database is opened or a generation registered.
 * It is the STRUCTURAL refusal and deliberately not the kind one: the refusal an
 * author meets is made at CONFIGURATION RESOLUTION, in the shape ADR-0048 gives
 * every other command input and with the command that produces a bundle in it
 * (`refuseUnbundledProcessor`, `config.ts`). What is left here is the guarantee
 * that no fold is ever registered without its bytes, whatever route the arrival
 * took.
 *
 * Two arrivals can still reach it. A SUBSTITUTED one, which is the ordinary case:
 * a test that injects `importModule` states what comes back for a path, and
 * `IndexingDependencies.processorBundle` states the BYTES that thing stands for,
 * whose hash is then its name exactly as a real bundle's is -- so a test registers a
 * generation the way a deployment does, bytes and all, and there is no route that
 * names a fold without them. And a path whose BYTES MOVED between the configuration
 * check and the read, where a half-landed rebuild fails closed rather than being
 * folded under a name nothing derived.
 *
 * **BYTES ON DISK WIN**: the substituted bundle is consulted only where the arrival
 * read none.
 */
export function requireArrivedBundle(
	processorPath: string,
	arrival: Pick<ProcessorArrival<Abi, unknown, unknown>, 'identity' | 'bundle'>,
	substituted?: Uint8Array,
): ArrivedBundle {
	if (arrival.identity !== undefined && arrival.bundle !== undefined) {
		return {identity: arrival.identity, bundle: arrival.bundle};
	}
	if (substituted !== undefined) {
		return {identity: processorArtifactIdentity(substituted), bundle: substituted};
	}
	throw new Error(
		`the processor at ${processorPath} is not a self-contained bundle, so this deployment has no identity for its ` +
			`fold and no code it could keep for it: a processor is identified by the SHA-256 of its bytes (ADR-0086), a ` +
			`Node deployment stores those bytes beside the generation they fold (ADR-0092), and an entry point that ` +
			`still resolves imports at run time has no bytes that describe it. Point --processor at a bundle that ` +
			`imports nothing.`,
	);
}

/** Everything a folding command holds over its one database handle. */
export type FoldingAssembly<ABI extends Abi, ProcessResultType = unknown> = {
	/**
	 * THE GENERATIONS THIS NAMED INDEXER HOLDS, and which one answers reads.
	 *
	 * The chain-free container (`@etherfold/core`), over the durable registry this
	 * database carries. It is what a command hands to its server as the entry for
	 * its name and to its `/status` reporter, and it is what a `run` adds a
	 * successor to.
	 */
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>;
	/** The ONE handle every one of them folds into and a server answers over. */
	db: RemoteSQL;
	/**
	 * ANY generation's state, by identity, UNCLAIMED: its own table namespace
	 * (ADR-0053), built the one way this deployment builds it (`foldPartsFor`).
	 *
	 * For READING a generation's position with no engine, which is what `/status`
	 * does for a canonical generation nothing here folds (`foldingStatusReport`).
	 * Unclaimed so that a read never takes the claim from the fold writing it.
	 */
	stateOf(id: GenerationId): StateStore;
	/** The OPENING fold's store: its own table namespace (ADR-0053), CLAIMED. */
	store: WritableStateStore;
	/** The OPENING fold's processor. */
	processor: EventProcessor<ABI, ProcessResultType>;
	/**
	 * THE WRITER of the stream the opening fold folds: this deployment's own, and
	 * the live wire context a single-stream process has.
	 *
	 * ## Why it is a WRITER and no longer a fold's receiver
	 *
	 * It used to be `container.ingestion` reaching for the opening FOLD's engine,
	 * whose getter asserted "the first fold held on a stream is never a follower".
	 * That assertion was a property of how `follows` was DERIVED -- from the folds a
	 * process happened to hold in memory, which at `open` is an empty list -- rather
	 * than of the shape, and ADR-0087 retires the question entirely: no generation
	 * fetches and none appends, so a fold has no receiver at all and the thing at a
	 * stream's address is the deployment's writer of it.
	 *
	 * It is reported, never fed through. What a combined command pushes into is
	 * resolved PER ASK from `container.liveIngestions()` (`prepareIndexing`), which is
	 * the same question the ingest route asks on the HTTP side, and what a serving
	 * command registers is that function itself. This field is what a CALLER reads to
	 * say which stream this process came up fetching.
	 */
	streamWriter: StreamWriter<ABI>;
};

/**
 * Open the GENERATION CONTAINER this command folds through: the registry over
 * this database, the fold it comes up holding, and the two ports that put what a
 * fold concluded into the same database.
 *
 * The STATE and the two factories come from `foldPartsFor` above, which is where
 * the namespacing convention and the claim live; this function is what pairs
 * them with the registry substrate and the stream's two ends.
 *
 * ## Why both ports are built HERE
 *
 * Because this is where the store is OWNED, and both durable facts a fold
 * concludes are written by whoever owns the store: the reorg count (ADR-0050)
 * and the stored emission stream (ADR-0052). All three folding commands come
 * through this function, so all three write both, and none of them can bind a
 * port to a different database than the one it folds into. Each used to live on
 * an HTTP route a combined process never touches, so `run` counted nothing and
 * `run` and `build` stored no stream at all.
 *
 * The APPENDER is handed to the container rather than to a receiver, which is
 * what makes the one-writer rule structural: the container gives it to the
 * STREAM's own WRITER -- the DEPLOYMENT's, one per stream -- and to no fold at
 * all, so no generation can append a second history (ADR-0052/ADR-0087). Beside
 * it go the other two ends of the same rows: where the stream REACHES, which is
 * what positions the fetch, and how it is READ BACK in bounded slices, because
 * every generation here catches up by re-folding it.
 *
 * The imports are dynamic for the reason `openFoldingDatabase`'s are.
 */
export async function openFolding<ABI extends Abi, ProcessResultType>(
	declared: EntityProcessor<ABI, any>,
	target: StoreTarget,
	db: RemoteSQL,
	context: {
		/** What this deployment indexes: half of the stream identity, and of the wire's. */
		source: IndexingSource<ABI>;
		/** The stream config, the other half, exactly as both halves of the wire were given it. */
		stream: ProvidedStreamConfig;
		/** The resolved finality depth, which the retention floor is checked against. */
		finalityDepth: number;
		/**
		 * The NAMED INDEXER this deployment folds under, which every stored emission
		 * row and every registry row is keyed on (ADR-0036).
		 *
		 * Required here and defaulted nowhere in this function: WHETHER a command may
		 * default it is a question about the command (`resolveIndexerName` for the
		 * combined shapes, `requireIndexerName` for the two halves of the wire), and a
		 * fallback here would be a third answer neither of them could see.
		 */
		indexer: string;
		/**
		 * WHEN the canonical pointer moves onto a successor added beside the live fold,
		 * exactly as this deployment's configuration said it (`resolvePromotion`,
		 * `config.ts`).
		 *
		 * OPTIONAL, and absent means the operator said nothing rather than that they
		 * said `on-catch-up`: the default is filled in ONE place
		 * (`resolvePromotionConfig`, `@etherfold/core`), and handing a value down from
		 * here when none was given would be this module forking a default whose whole
		 * point is that it cannot be forked. Passed through untouched for the same
		 * reason `indexer` is required here: WHETHER a command may take this input is a
		 * question about the command, answered by the resolver.
		 */
		promotion?: PromotionConfig;
		/**
		 * What the ARRIVAL produced -- the bundle this deployment was configured with and
		 * its hash, which names the fold (ADR-0086) and whose bytes the registration keeps
		 * (ADR-0092). Passed straight through to `foldPartsFor`, and REQUIRED there.
		 */
		arrived: ArrivedBundle;
	},
): Promise<FoldingAssembly<ABI, ProcessResultType>> {
	const [server, parts] = await Promise.all([
		// the stream's two ends and the registry substrate are the TABLE OWNER's:
		// `@etherfold/server` ships the DDL, both of ADR-0006's views and the seq
		// allocation the writer and the reader have to agree about, so a second copy of
		// any of them here would be a second definition of what a position in that
		// stream means. What this module owns is which DATABASE and which NAME.
		import('@etherfold/server'),
		// the state, the identity and the two factories, built the ONE way this
		// deployment builds them -- so a fold added later by a RE-READ lands in the same
		// database under the same convention (`foldPartsFor`).
		foldPartsFor<ABI, ProcessResultType>(declared, target, db, context.finalityDepth, context.arrived),
	]);
	const {stateFor} = parts;

	const container = await openContainerOver<ABI, ProcessResultType>(server, db, context, {
		stateFor,
		// HOW A GENERATION THIS BUILD WAS NOT MADE WITH FOLDS AGAIN (ADR-0092): the bundle
		// stored on its registry row goes through the SAME loader a `--processor` bundle
		// goes through (ADR-0085), and the fold over it is assembled by the SAME
		// `foldPartsFor` -- so its state is the namespace its identity names, which is the
		// one it answered reads from, under this deployment's retention and finality. The
		// container calls it when the pointer moves onto such a generation, which is the
		// revert on a process redeployed with the new processor alone. It lives HERE and
		// not in `@etherfold/core` because the loader is `@etherfold/utils`', which depends
		// on core.
		//
		// The identity handed back is the loader's hash of the bytes, NOT the identity asked
		// for: the container compares the two, so stored code that does not name its
		// generation is refused rather than folded under a borrowed name.
		instantiateGeneration: async (_id, bundle) => {
			const outcome = await loadStoredBundle<ABI, ProcessResultType>(bundle);
			const resumed = await foldPartsFor<ABI, ProcessResultType>(outcome.processor, target, db, context.finalityDepth, {
				identity: outcome.identity,
				bundle,
			});
			return resumed.generation;
		},
		generation: parts.generation,
		source: context.source,
	});

	return {
		container,
		db,
		stateOf: stateFor,
		store: container.state,
		processor: container.processor,
		// THE WRITER of the stream the opening fold folds, which is the DEPLOYMENT's and
		// not that fold's engine (ADR-0087). A fold has no receiver at all now, so what a
		// caller reads here to say "which thing is fetching this stream" is this.
		streamWriter: container.ingestion,
	};
}

/**
 * THE STORED BYTES, through the SAME loader a `--processor` bundle and an upload go
 * through (ADR-0085), or a refusal naming why: what every instantiation from a
 * registry row starts with.
 */
async function loadStoredBundle<ABI extends Abi, ProcessResultType>(bundle: Uint8Array) {
	const outcome = await loadProcessorArtifact<ABI, ProcessResultType, EntityProcessor<ABI, any>>(bundle);
	if (outcome.status === 'refused') {
		throw new Error(`the stored bundle ${outcome.identity} was refused as ${outcome.reason}: ${outcome.why}`);
	}
	return outcome;
}

/**
 * What a folding deployment started with NOTHING configured holds over its one
 * database (ADR-0093): the container, the handle, and how any generation's state is
 * read -- and no opening fold, no store and no writer, because it has none until a
 * processor arrives.
 */
export type WaitingFoldingAssembly<ABI extends Abi, ProcessResultType = unknown> = Pick<
	FoldingAssembly<ABI, ProcessResultType>,
	'container' | 'db' | 'stateOf'
> & {
	/**
	 * HOW THIS DEPLOYMENT BUILDS THE FOLD PARTS OF A PROCESSOR THAT ARRIVES: `foldPartsFor`,
	 * noting the entities that processor declares.
	 *
	 * A configured deployment drops and reads any generation's namespace through the
	 * entities of the processor it was CONFIGURED with (`openFolding`). A waiting one was
	 * configured with none, so it uses every entity a processor that arrived in this
	 * process declared -- a `DROP` is `IF EXISTS`, so naming more tables than a namespace
	 * holds is harmless where naming fewer would leave some behind. An arrival that builds
	 * its parts any other way would leave its tables out of that set.
	 */
	foldParts: typeof foldPartsFor;
};

/**
 * Open the GENERATION CONTAINER of a `run` started with NOTHING configured (ADR-0093):
 * the same registry, caps, ports and stream ends `openFolding` wires, over the same
 * database -- and no fold and no source of its own.
 *
 * NOTHING stands in for either. There is no placeholder processor, source or
 * generation: that is the defaulted input ADR-0048 and ADR-0093 both reject, a fold
 * nobody chose looking healthy. What the container comes up holding is what its
 * REGISTRY says:
 *
 *  - a CANONICAL GENERATION whose stored bundle this process can run is instantiated at
 *    `open`, exactly as an upgrading restart instantiates it (ADR-0092), and the source
 *    it folds is the one THAT BUNDLE CARRIES, resolved through the route a processor
 *    module supplies its contracts by (`resolveSource`) -- which is what the container
 *    then fetches (`ReceivingIndexer.fetchedSource`);
 *  - a canonical generation it CANNOT instantiate is logged and served frozen, and the
 *    deployment starts anyway, as a restart already does;
 *  - with no canonical generation at all it holds nothing, fetches nothing, and waits.
 *
 * `provider` is the chain, for the one step of resolving a stored bundle's contracts
 * that may cost an `eth_chainId` call.
 */
export async function openWaitingFolding<ABI extends Abi, ProcessResultType>(
	target: StoreTarget,
	db: RemoteSQL,
	context: {
		stream: ProvidedStreamConfig;
		finalityDepth: number;
		indexer: string;
		promotion?: PromotionConfig;
		provider: EIP1193ProviderWithoutEvents;
	},
): Promise<WaitingFoldingAssembly<ABI, ProcessResultType>> {
	const [server, {VersionedStateStore}] = await Promise.all([
		import('@etherfold/server'),
		import('@etherfold/state-store-sqlite'),
	]);

	/** Every entity a processor that arrived here declared, first declaration of a name kept. */
	const declared = new Map<string, EntityDeclaration>();
	const stateFor = (id: GenerationId): SQLiteStateStore =>
		new VersionedStateStore(db, [...declared.values()], {
			tableNamespace: generationDigestOf(id),
			retention: target.retention,
			finalityDepth: context.finalityDepth,
		});
	const foldParts: typeof foldPartsFor = (processor, ...rest) => {
		for (const entity of processor.entities) {
			if (!declared.has(entity.name)) declared.set(entity.name, entity);
		}
		return foldPartsFor(processor, ...rest);
	};

	const container = await openContainerOver<ABI, ProcessResultType>(server, db, context, {
		stateFor,
		// THE SAME PATH FROM STORED BYTES TO A FOLD as a configured deployment's, plus the
		// one thing a configured deployment already knows and this one cannot: WHAT the
		// stored bundle indexes. It is read from the bundle itself, which always carries its
		// own contracts (ADR-0085's amendment), so the generation folds the source it was
		// registered under -- and the container refuses it as frozen where that is not so.
		instantiateGeneration: async (_id, bundle) => {
			const outcome = await loadStoredBundle<ABI, ProcessResultType>(bundle);
			const source = await openIndexingSource<ABI, ProcessResultType>(
				{from: 'processor-module'},
				outcome.processorModule,
				context.provider,
			);
			const resumed = await foldParts<ABI, ProcessResultType>(outcome.processor, target, db, context.finalityDepth, {
				identity: outcome.identity,
				bundle,
			});
			return {...resumed.generation, source};
		},
	});

	return {container, db, stateOf: stateFor, foldParts};
}

/**
 * THE CONTAINER OVER ONE DATABASE, with every seam this deployment injects: the
 * registry substrate and how a generation's state is dropped and read, the caps, the
 * promotion policy, the reorg counter, the stream's three ends, and how stored bytes
 * become a fold.
 *
 * Written once for the two ways a folding deployment opens -- CONFIGURED, with a fold
 * and a source of its own (`openFolding`), and with NOTHING configured, holding neither
 * (`openWaitingFolding`, ADR-0093) -- so the two cannot differ in anything but that.
 */
async function openContainerOver<ABI extends Abi, ProcessResultType>(
	server: typeof import('@etherfold/server'),
	db: RemoteSQL,
	context: {
		stream: ProvidedStreamConfig;
		indexer: string;
		promotion?: PromotionConfig;
	},
	seams: {
		/** Any generation's state, by identity, UNCLAIMED: what a DROP and a position read go through. */
		stateFor(id: GenerationId): SQLiteStateStore;
		instantiateGeneration: NonNullable<
			ReceivingIndexerOptions<ABI, ProcessResultType, WritableStateStore>['instantiateGeneration']
		>;
		generation?: ReceivedGenerationSpec<ABI, ProcessResultType, WritableStateStore>;
		source?: IndexingSource<ABI>;
	},
): Promise<ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>> {
	const {stateFor} = seams;
	return openReceivingIndexer<ABI, ProcessResultType, WritableStateStore>({
		port: server.generationRegistryPortOnSQL(db, context.indexer, {
			// deleting a generation is a DROP of its namespace, which is the whole reason
			// the namespace was chosen over a column (ADR-0053). The registry cannot know
			// that convention and deliberately does not: it is injected by whoever named
			// the tables, which is this function.
			dropState: async (id) => {
				await stateFor(id).drop();
			},
			// ...and READING how far that namespace's fold got is the same injection, for
			// the same reason and from the same `stateFor`: it is what lets the promotion
			// trigger measure the CANONICAL generation on a process redeployed with a
			// changed processor, which holds no fold for it and never could -- the old
			// processor's code is not in this build. No engine is involved and none is
			// retained: the store is built UNCLAIMED (`stateFor`, not `openForWriting`, so
			// reading a position never takes the claim away from the fold that is writing
			// it) and one row is read.
			//
			// It is the identity's OWN namespace, so there is no second check that the
			// cursor found there was written by this generation: the address IS the pair
			// `{stream, processor}` (ADR-0053). `undefined` for "nothing written yet, or a
			// cursor that cannot be parsed" is `localPosition`'s own rule, and it is the
			// answer the trigger needs -- never a zero.
			readStateCursor: (id) => localPosition(stateFor(id)),
		}),
		// A CLI is a server: the database IS the durable artifact here and the retained
		// generation is what the pointer moves BACK to, so it states the same generous
		// bound a server does rather than a browser tab's two (`SERVER_GENERATION_CAPS`).
		// It is stated rather than defaulted because a cap nobody can see is not a bound;
		// there is deliberately no flag for it, since no command in the set takes one and
		// the number a deployment wants is the one this constant already argues for.
		caps: SERVER_GENERATION_CAPS,
		// WHEN the pointer moves onto a successor, and what happens to the generation
		// left behind. Absent is a real answer and the common one, and the container
		// resolves the default from it.
		...(context.promotion === undefined ? {} : {promotion: context.promotion}),
		stream: context.stream,
		recordReorg: reorgRecorderFor(db),
		// THE STREAM'S THREE ENDS, all over the one database this command folds into:
		// where it is STORED, where it REACHES (which is what positions the fetch, and is
		// the half that makes the write duty movable at all -- ADR-0087), and how it is
		// READ BACK in bounded slices so every generation over it can re-fold it.
		appendEmissions: server.emissionAppenderFor(db, context.indexer),
		streamCursor: server.streamCursorSourceOn(db, context.indexer),
		replay: server.storedEmissionReplaySource<ABI>(db, context.indexer),
		// HOW STORED BYTES BECOME A FOLD (ADR-0092), which is the caller's: the two ways a
		// deployment opens differ in where a stored bundle's SOURCE comes from.
		instantiateGeneration: seams.instantiateGeneration,
		// WHAT THIS HOST OPENS WITH, where it was configured with anything at all: its own
		// fold and its source. Both ABSENT on a node started with nothing configured
		// (ADR-0093), which opens holding only what its registry's canonical generation
		// names and fetches whatever its first fold carries.
		...(seams.generation === undefined ? {} : {generation: seams.generation}),
		...(seams.source === undefined ? {} : {source: seams.source}),
	});
}

/**
 * WHAT THIS PROCESS TELLS `/status`: one entry per generation it holds, the
 * canonical one's progress as the top-level value, and the canonical generation
 * named on its own -- whether it folds here and where it stands -- held or not.
 *
 * The lines a host writes between what it HOLDS and what the reporter reads
 * (ADR-0047), written once here because `run` and `index` hold the same container
 * and must not answer the same question two ways. The shape does not depend on
 * how many generations a deployment happens to hold: a process holding one
 * reports one entry, and the same process mid-upgrade reports two, which is how
 * an operator watches a rebuild advance on the page they already have open.
 *
 * A CANONICAL GENERATION NOTHING HERE FOLDS (its stored code could not be built at
 * `open`, a revert across a filter change: ADR-0092) is not one of those entries,
 * because the list is what this process holds. It is reported in the `canonical`
 * slot instead, with the container's own `folding` answer for it (the admin
 * listing's words) and its position read from its namespace through `stateOf`,
 * with no engine. That costs one `foldingOf` and at most one cursor read per
 * `/status`, and never one per registered generation.
 *
 * The `state` a fold carries is this module's own `VersionedStateStore` -- the
 * container types it as an opaque parameter precisely so `@etherfold/core` names
 * no storage seam -- so the narrowing is honest exactly here, where the factory
 * that built it is written.
 */
export async function foldingStatusReport<ABI extends Abi, ProcessResultType>(
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>,
	/** Any generation's state, unclaimed (`FoldingAssembly.stateOf`): where an unheld canonical position is read. */
	stateOf: (id: GenerationId) => StateStore,
	/**
	 * Present exactly while this process is WAITING for a processor (ADR-0093): started
	 * with nothing configured, it fetches nothing until an upload names what to index.
	 * Carried onto the page verbatim, beside whatever else it holds.
	 */
	waiting?: WaitingReport,
): Promise<StatusReport> {
	const canonical = await container.canonical();
	return readStatusReport({
		...(waiting === undefined ? {} : {waiting}),
		folds: container.held().map((fold) => ({
			generation: fold.record,
			store: fold.state as StateStore,
			// TRUE FOR EVERY FOLD ON THIS RUNTIME, and that is the fact rather than a
			// constant nobody updated: under ADR-0087 no generation fetches, so every one of
			// them advances by re-folding the stream the deployment stored. The field stays
			// on the report because an operator comparing two deployments reads it; what it
			// no longer distinguishes is two shapes of fold, because there is one.
			follows: true,
		})),
		...(canonical
			? {
					canonical,
					// the SAME derivation the admin listing reports, for this one generation
					...(await foldingAnswerOf(container, canonical)),
					// ...and its own namespace, which the reporter reads only where no held fold is it
					canonicalState: stateOf({stream: canonical.stream, processor: canonical.processor}),
				}
			: {}),
	});
}

/**
 * The container's `folding` answer for the canonical generation, or NOTHING where the
 * question itself failed (a registry read that threw): the report then says nothing
 * about it rather than guessing, and the rest of `/status` still answers -- the rule
 * the per-fold cursor reads already follow (`readStatusReport`).
 */
async function foldingAnswerOf<ABI extends Abi, ProcessResultType>(
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>,
	canonical: GenerationRecord,
): Promise<{canonicalFolding?: GenerationFolding}> {
	try {
		return {canonicalFolding: await container.foldingOf(canonical)};
	} catch (err) {
		logger.error(
			`status: whether the canonical generation ${generationDigestOf(canonical)} can fold here could not be read, ` +
				`so it is reported without a \`folding\` answer`,
			err,
		);
		return {};
	}
}
