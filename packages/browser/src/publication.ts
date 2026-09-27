import {
	generationDigestOf,
	isPublicationIndex,
	publishedBodyLocation,
	type PublicationIndex,
	type PublishedStateSnapshot,
} from '@etherfold/core';
import {logs} from 'named-logs';

const namedLogger = logs('@etherfold/browser');

// ---------------------------------------------------------------------------------------------------
// A TAB STARTS FROM A PUBLICATION INDEX (ADR-0095)
// ---------------------------------------------------------------------------------------------------
// A build publishes, under ONE mutable `publication.json`, the latest state snapshot
// PER GENERATION and (when asked) the latest stream seed PER STREAM. This module is
// the tab's half: read the index, failing over between the locations the build
// names, and pick the entries THIS tab can use.
//
// It COMPOSES what exists and replaces nothing. The snapshot is still installed by
// the existing bootstrap (`openAndBootstrap`, the snapshot-only mode), which the
// app's `createState` calls with the location and processor handed to it; the seed
// is still installed by the hook's existing seed install into `keepStream`. What
// this adds is WHICH body, and a reported reason when there is none.
// ---------------------------------------------------------------------------------------------------

/**
 * WHERE A PUBLICATION INDEX IS, and what this tab takes from it, as
 * `createIndexerState`'s `publication` option takes it.
 *
 * ## The trust contract is the snapshot's and the seed's (ADR-0066)
 *
 * The CALLER names the locations and owns that choice: the index is fetched where
 * it is pointed and nowhere else, and so are the bodies it names (relative to it).
 * Keep the list in the BUILD, as the snapshot and seed locations always were.
 */
export type BrowserPublicationOptions = {
	/**
	 * The index locations (`.../publication.json`), in the order they are tried. A
	 * location that does not answer, or answers with something that is not an index
	 * this build reads, is skipped for the next, as the snapshot bootstrap fails over
	 * between mirrors; the FIRST index read is the one used. A relative, hostless
	 * path is a first-class location (a build-embedded copy), ordinarily LAST.
	 */
	locations: string | readonly string[];
	/**
	 * Whether to install the STREAM SEED the index lists for this tab's stream. OFF
	 * by default (ADR-0095: "the stream seed is opt-in, at both ends"): an app with a
	 * small state over a long history pays only for the state, and no seed is fetched
	 * even when the index lists one.
	 *
	 * `true` asks for it with the install's defaults; an object asks for it with the
	 * install's own knobs. It needs a `keepStream`, exactly as the `seed` option does,
	 * and it EXCLUDES that option: one seed per boot, from one place.
	 */
	seed?:
		| true
		| {
				/** An OPTIONAL pin, as `BrowserStreamSeedOptions.expectedContentHash`. Keep it in the build. */
				expectedContentHash?: string;
				/** As `BrowserStreamSeedOptions.reachBackTo`. */
				reachBackTo?: number;
				/** As `BrowserStreamSeedOptions.maxEventsPerBatch`. */
				maxEventsPerBatch?: number;
		  };
	/** Injectable for tests and for a host with its own retry/timeout policy. Used for the index and the seed. */
	fetch?: typeof globalThis.fetch;
};

/**
 * THE STATE SNAPSHOT THE INDEX NAMES FOR THIS GENERATION, as `createState` is handed
 * it: exactly the two arguments the existing bootstrap takes.
 *
 * ```ts
 * createState: async (context, {signal}, bundle, published) => {
 *   const backend = await createBrowserStateStore(entities, {databaseName: `app-${context.stream}`});
 *   const {store} = published
 *     ? await openAndBootstrap(backend, published.locations, {
 *         processor: published.processor,
 *         replaceLocal: published.replaceLocal,
 *         finalityDepth: 12,
 *       })
 *     : {store: await openSnapshotAware(backend)};
 *   return openForWriting(store, {signal});
 * },
 * ```
 */
export type PublicationSnapshot = {
	/** Where the body is, resolved against the index that named it: `openAndBootstrap`'s locations. */
	readonly locations: readonly string[];
	/**
	 * The processor the entry was computed by, which IS this generation's identity:
	 * `openAndBootstrap`'s `processor`. Handed back rather than left for the app to
	 * restate, so the equality the bootstrap checks is the one the index was read by.
	 */
	readonly processor: string;
	/** The index entry, verbatim, for an app that renders where its state came from. */
	readonly entry: PublishedStateSnapshot;
	/** Which index location named it. */
	readonly index: string;
	/**
	 * WHETHER THE LOCAL STATE IS TO BE REPLACED: `openAndBootstrap`'s `replaceLocal`,
	 * so forward it.
	 *
	 * `false` when the generation is built at `init`: a tab that already holds local
	 * state keeps it and catches up from its own cursor. `true` when the hook builds
	 * the generation AGAIN mid-run because the catch-up was abandoned (ADR-0096: the
	 * node refused it as an archive refusal, or it was estimated to take longer than
	 * `catchUpWithinSeconds`), so the snapshot is installed over the local state, which
	 * the install wipes first. A `createState` that does not forward it keeps its
	 * local state, and the hook then reports the refusal it would have reported anyway.
	 */
	readonly replaceLocal: boolean;
};

/**
 * WHY A RETURNING TAB ABANDONED ITS CATCH-UP for the published snapshot (ADR-0096).
 *
 * - `archive-refused`: the node refused the catch-up as needing archive access
 *   (`ArchiveRefusedError`), which no retry and no range size fixes.
 * - `over-budget`: the catch-up was estimated to take longer than the app's
 *   `catchUpWithinSeconds`.
 */
export type SnapshotSwitchReason = 'archive-refused' | 'over-budget';

/**
 * HOW LONG A RETURNING TAB MAY SPEND CATCHING UP before it starts from the
 * published snapshot instead, in seconds: `createIndexerState`'s
 * `catchUpWithinSeconds` when none is given (ADR-0096).
 *
 * Thirty seconds, because it is a WAIT A USER SITS THROUGH with the app showing
 * stale state, and past about that long an app reads as broken rather than busy;
 * a snapshot the index names is sized by the state and not the history (a fraction
 * of a megabyte on the reference deployment), so installing it is a few seconds on
 * any connection that also serves the app. A value per chain is the app's to
 * choose.
 */
export const DEFAULT_CATCH_UP_WITHIN_SECONDS = 30;

/**
 * WHY THIS TAB STARTS FROM NO PUBLISHED SNAPSHOT, when it was pointed at an index.
 *
 * Each is an ordinary outcome and never gates the boot: the tab indexes from the
 * chain as it does with no snapshot at all.
 */
export type PublicationRefusalReason =
	/** Every index location failed to FETCH. Transport: another try, or another location, may answer. */
	| 'unreachable'
	/**
	 * Something WAS fetched and it is not a publication index this build reads, at
	 * every location that answered. Content, not transport (ADR-0071): the app or
	 * the publisher is out of date, and retrying never helps.
	 */
	| 'unreadable-format'
	/** The index names no snapshot for this processor at all, on any stream. */
	| 'no-entry'
	/**
	 * The index names a snapshot for THIS processor over ANOTHER stream: the
	 * publisher's contracts or finality differ from this app's. Refused rather than
	 * installed, because a tab keeps an installed snapshot only when the cursor's
	 * source and stream-config hashes are its own, and would otherwise discard it on
	 * the first load and index from the start block (ADR-0095). Nothing is fetched
	 * beyond the index.
	 */
	| 'stream-mismatch'
	/**
	 * The generation has no identity before its processor is built, so no entry can
	 * be chosen for it: a MODULE arrival is named by its handler sources only once the
	 * fold exists (`moduleProcessorIdentity`). A tab starting from a publication runs
	 * the published BUNDLE (`processorBundle`, ADR-0095), whose identity is known
	 * before its state is built.
	 */
	| 'no-processor-identity';

/**
 * WHAT THE PUBLICATION INDEX GAVE THIS TAB, as `SyncingState.publication` reports it.
 *
 * It reports the LOOKUP, and nothing about the install: whether the snapshot then
 * installed is what `openAndBootstrap` answers the app's own `createState`, and
 * what the seed install did is `SyncingState.streamSeed`, as it always was.
 */
export type PublicationState =
	/** The index is being read, or read and waiting for the generation it is for to be built. */
	| {readonly status: 'reading'}
	| {
			/** The index names a snapshot for this generation, and `createState` was handed it. */
			readonly status: 'found';
			/** Which index location named it. */
			readonly from: string;
			/** Where the snapshot body is. */
			readonly snapshot: string;
			/** The block the snapshot's rows are as of. */
			readonly at: number;
	  }
	| {
			/**
			 * The tab HELD LOCAL STATE, started catching up from its own cursor, and
			 * abandoned that for the snapshot the index names: the local state was wiped
			 * and the snapshot installed through `createState` (handed `replaceLocal`), and
			 * the tab indexes forward from the snapshot's cursor (ADR-0096).
			 */
			readonly status: 'switched';
			readonly reason: SnapshotSwitchReason;
			/** Which index location named the snapshot. */
			readonly from: string;
			/** Where the snapshot body is. */
			readonly snapshot: string;
			/** The block the snapshot's rows are as of, which is where the tab now resumes. */
			readonly at: number;
			/** How far the local state had got when it was abandoned. */
			readonly left: number;
			/** For `over-budget`: how long the rest of the catch-up was estimated to take, in seconds. */
			readonly estimateSeconds?: number;
			/** For `over-budget`: the budget it exceeded, in seconds (`catchUpWithinSeconds`). */
			readonly budgetSeconds?: number;
	  }
	| {
			/** No published snapshot for this generation. The tab starts ANYWAY, indexing from the chain. */
			readonly status: 'refused';
			readonly reason: PublicationRefusalReason;
			/** Which index location was read, where one was. */
			readonly from?: string;
			/**
			 * For `stream-mismatch`: the stream digests the entries for this processor ARE
			 * for, so an app can say "published for other contracts or finality" by name.
			 */
			readonly streams?: readonly string[];
	  };

/** An index that was read, and where from; or why none was. */
export type ReadPublication =
	| {readonly status: 'read'; readonly index: PublicationIndex; readonly from: string}
	| {readonly status: 'unreachable' | 'unreadable-format'};

/**
 * READ THE FIRST PUBLICATION INDEX ANY LOCATION SERVES.
 *
 * Walks the locations in order. A location that does not answer (or answers with an
 * error status) is `unreachable`; one that answers with anything but an index of
 * this format is `unreadable-format`. Either is logged and the next location is
 * tried; the most specific reason is reported when none serves one.
 */
export async function readPublicationIndex(
	locations: string | readonly string[],
	fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ReadPublication> {
	const all = typeof locations === 'string' ? [locations] : locations;
	let reason: 'unreachable' | 'unreadable-format' = 'unreachable';
	for (const location of all) {
		let response: Response;
		try {
			response = await fetch(location);
			if (!response.ok) throw new Error(`${location} answered ${response.status}`);
		} catch (error) {
			namedLogger.error(`could not read the publication index at ${location}, trying the next location`, error);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			parsed = undefined;
		}
		if (!isPublicationIndex(parsed)) {
			namedLogger.error(`the document at ${location} is not a publication index this build reads`);
			reason = 'unreadable-format';
			continue;
		}
		return {status: 'read', index: parsed, from: location};
	}
	return {status: reason};
}

/**
 * THE SNAPSHOT ENTRY FOR ONE GENERATION, or why there is none.
 *
 * Looked up by GENERATION (`generationDigestOf`), because that is what a tab can
 * keep: an entry for this processor over another stream is refused BY NAME rather
 * than handed over to be installed and then discarded by the first load.
 */
export function publishedSnapshotFor(
	read: ReadPublication,
	generation: {readonly stream: string; readonly processor: string | undefined},
): {readonly snapshot?: PublicationSnapshot; readonly state: PublicationState} {
	if (read.status !== 'read') return {state: {status: 'refused', reason: read.status}};
	const from = read.from;
	const processor = generation.processor;
	if (processor === undefined) return {state: {status: 'refused', reason: 'no-processor-identity', from}};

	const entry = read.index.snapshots[generationDigestOf({stream: generation.stream, processor})];
	if (entry && entry.stream === generation.stream && entry.processor === processor) {
		const location = publishedBodyLocation(from, entry.body);
		return {
			snapshot: {locations: [location], processor, entry, index: from, replaceLocal: false},
			state: {status: 'found', from, snapshot: location, at: entry.takenAt.number},
		};
	}
	const streams = Object.values(read.index.snapshots)
		.filter((other) => other.processor === processor)
		.map((other) => other.stream);
	if (streams.length > 0) {
		namedLogger.warn(
			`the publication index at ${from} names snapshots of processor \`${processor}\` only for stream(s) ` +
				`${streams.join(', ')}, and this tab folds stream ${generation.stream}: the publisher's contracts or ` +
				`finality differ from this app's, so none is installed`,
		);
		return {state: {status: 'refused', reason: 'stream-mismatch', from, streams}};
	}
	return {state: {status: 'refused', reason: 'no-entry', from}};
}

/** Where the seed the index lists for this stream is, or no location at all. */
export function publishedSeedLocationsFor(read: ReadPublication, stream: string): string[] {
	if (read.status !== 'read') return [];
	const entry = read.index.seeds?.[stream];
	return entry && entry.stream === stream ? [publishedBodyLocation(read.from, entry.body)] : [];
}
