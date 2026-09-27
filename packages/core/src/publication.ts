import type {StreamSeedCoverage} from './stream/seed.js';

// ---------------------------------------------------------------------------------------------------
// THE PUBLICATION INDEX, as a document both of its sides read (ADR-0095)
// ---------------------------------------------------------------------------------------------------
// `publication.json` is written by a PRODUCER (`producePublication` in
// `@etherfold/server`, wrapped by `etherfold publish` and `build --publish`) and read
// by a CLIENT (a browser tab pointed at it, `@etherfold/browser`). Its shape is
// defined HERE, in the one package both sides already depend on, so the two cannot
// drift: a producer that lived in a server package and a reader that restated the
// shape beside it would be two definitions of one contract.
//
// Only the DOCUMENT is here. Producing one (the cut, the bodies, the merge) is the
// server's; choosing an entry and starting from it is the browser's.
// ---------------------------------------------------------------------------------------------------

/** The name of the publication index inside a publication (ADR-0095). Deliberately not a "head". */
export const PUBLICATION_INDEX_NAME = 'publication.json';

/**
 * The version of the publication index DOCUMENT.
 *
 * A producer refuses to rewrite an index of another format (rewriting it would
 * forget the entries it cannot read), and a client refuses to read one: the
 * whole point of the index is that nothing a publication named is misread.
 */
export const PUBLICATION_INDEX_FORMAT = 1;

/**
 * ONE STATE SNAPSHOT a publication names: the latest one published for ONE
 * generation, keyed in the index by that generation's digest (`generationDigestOf`).
 *
 * Carries the generation's two halves apart (`stream`, `processor`) so a tab can
 * find the entry for its own processor on ANOTHER stream and say why it cannot use
 * it, rather than silently finding nothing.
 */
export type PublishedStateSnapshot = {
	/** The stream digest of the generation that computed the rows: its source and stream config. */
	readonly stream: string;
	/** The processor identity of that generation (ADR-0086): the SHA-256 of its bundle's bytes. */
	readonly processor: string;
	/** The body's file name, relative to the index. Content-addressed, so it never changes. */
	readonly body: string;
	/** The content hash of the DECOMPRESSED document, as ADR-0066 defines and renders one. */
	readonly contentHash: string;
	/** The block the rows are AS OF: the highest recorded block at or below the cut. */
	readonly takenAt: {readonly number: number; readonly hash: string; readonly timestamp: number};
	/**
	 * The history floor the installed store reports: the body carries the rows live
	 * at it and every later block's changes up to `takenAt`. Equal to
	 * `takenAt.number` for history `none`.
	 */
	readonly floor: number;
	/** The cut: `tip - finality`, and the `lastToBlock` of the resume position the body carries. */
	readonly cut: number;
	/** When it was produced. Informational. */
	readonly savedAt: string;
};

/**
 * ONE STREAM SEED a publication names: the latest one published for ONE STREAM,
 * keyed in the index by that stream's digest.
 *
 * Keyed by stream and not by generation, because a seed belongs to a stream and
 * not to a processor: an old build on the same stream still takes the newest seed
 * (ADR-0095). The body is the seed envelope (`StreamSeed`, ADR-0063 to ADR-0066),
 * gzipped.
 */
export type PublishedStreamSeed = {
	/** The stream digest the seed is for, as a client recomputes it (ADR-0064). Also its key. */
	readonly stream: string;
	/** The body's file name, relative to the index. Content-addressed, so it never changes. */
	readonly body: string;
	/**
	 * The content hash of the DECOMPRESSED payload (ADR-0066): the value
	 * `streamSeedContentHash` computes and an install's `expectedContentHash` pins.
	 */
	readonly contentHash: string;
	/** How far the seed reaches: the stream's start block up to the cut the state snapshot was taken at. */
	readonly coverage: StreamSeedCoverage;
	/** How many stored events it carries. Informational: what a tab downloads is proportional to it. */
	readonly events: number;
	/** When it was produced. Informational, and NOT inside the body, so the body stays deterministic. */
	readonly savedAt: string;
};

/**
 * THE PUBLICATION INDEX (`publication.json`): the latest state snapshot PER
 * GENERATION, keyed by `generationDigestOf`, and the latest stream seed PER
 * STREAM, keyed by stream digest (absent until a publication was asked for one).
 *
 * Entries are never removed: an OLD build of an app runs the old processor and
 * finds the last snapshot of its own generation here, stale but valid (ADR-0095).
 * Keys this build does not know are carried through a republication untouched.
 */
export type PublicationIndex = {
	readonly format: number;
	readonly snapshots: Readonly<Record<string, PublishedStateSnapshot>>;
	readonly seeds?: Readonly<Record<string, PublishedStreamSeed>>;
};

/**
 * Whether a parsed document is a publication index of THIS format.
 *
 * The container shape only (`format`, the `snapshots` map, the optional `seeds`
 * map): what an entry holds is the producer's, and the one reader that acts on an
 * entry fetches the body it names and checks THAT on its own terms.
 */
export function isPublicationIndex(value: unknown): value is PublicationIndex {
	const candidate = value as {format?: unknown; snapshots?: unknown; seeds?: unknown} | undefined;
	return (
		!!candidate &&
		typeof candidate === 'object' &&
		!Array.isArray(candidate) &&
		candidate.format === PUBLICATION_INDEX_FORMAT &&
		isMap(candidate.snapshots) &&
		// absent until a publication asks for a seed; present, it is a map like `snapshots`
		(candidate.seeds === undefined || isMap(candidate.seeds))
	);
}

function isMap(value: unknown): boolean {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * WHERE A BODY THE INDEX NAMES IS, given where the index was read from.
 *
 * A body is named RELATIVE to its index, so a publication directory can be served
 * from any host or path, including a build-embedded, hostless relative one
 * (`/indexed-states/publication.json`), which is resolved by replacing the index's
 * own file name rather than through `URL` (which would need a base the location
 * does not carry).
 */
export function publishedBodyLocation(indexLocation: string, body: string): string {
	let absolute: URL | undefined;
	try {
		absolute = new URL(indexLocation);
	} catch {
		absolute = undefined;
	}
	if (absolute) return new URL(body, absolute).href;
	const path = indexLocation.replace(/[?#].*$/, '');
	return `${path.slice(0, path.lastIndexOf('/') + 1)}${body}`;
}
