import type {Abi, LastSync} from '@etherfold/core';
import {
	encodeSnapshot,
	ENTITY_SNAPSHOT_FORMAT,
	isReadableSnapshotHead,
	openSnapshotAware,
	readSnapshot,
	SnapshotFormatError,
	type BlockPointer,
	type EntityDeclaration,
	type Mutation,
	type SnapshotAwareStateStore,
	type SnapshotHead,
	type SnapshotReader,
	type StateSnapshot,
	type StateStore,
	type StateStoreBackend,
} from '@etherfold/state-store';
import {logs} from 'named-logs';
import {parseStoredCursor, serializeLastSync, SYNC_CURSOR_KEY} from './cursor.js';

const logger = logs('@etherfold/processor-entities');

/**
 * ## Starting near the tip: the capability the retired free-form path had first
 *
 * That path's `keepStateOnIndexedDB(name, remote)` took a URL or an ARRAY of
 * them, asked each mirror how far it had got, used the one that had got
 * furthest, preferred the LOCAL state when local was already further along, and
 * failed over to the next mirror when one was unreachable rather than dying.
 * That is what let a new tab of a shipped app come up in a second instead of
 * replaying every log the contract ever emitted. It is deleted (ADR-0037), and
 * this module is where the behaviour lives now.
 *
 * This is that behaviour for a store of versioned rows. What differs is only the
 * shape of what is downloaded (a format-2 snapshot DOCUMENT, at the seam: rows at
 * a floor then the blocks above it, gzipped and newline-delimited, ADR-0095,
 * rather than one blob) and one thing the blob shape had no
 * counterpart for, because a blob has no history to lie about: a
 * bootstrapped store must report the floor its snapshot gives it, which
 * `openSnapshotAware` is responsible for and which this module simply must not
 * bypass.
 *
 * ## Why the mirror logic is HERE and not in `@etherfold/browser`
 *
 * Because it needs to read `lastToBlock` out of a stored cursor to answer "is
 * local already ahead", and the cursor's codec lives here (the seam persists an
 * opaque string on purpose, ADR-0027). `@etherfold/browser` deliberately does
 * not depend on any entity runtime -- it types the entity path structurally so
 * that it imports no processor package -- so putting this there would invert
 * that. Nothing here is browser-specific: `fetch` is a global in every runtime
 * this project targets, and a node consumer bootstraps with the same call.
 *
 * ## What this is NOT
 *
 * It is not the publishing side. The producer that reads a snapshot out of a
 * database is the SQLite backend's (`produceStateSnapshot`,
 * `@etherfold/state-store-sqlite`), and what a build publishes, where, and under
 * which index is ADR-0095's. `createSnapshot` below is the MINIMAL producer this
 * module's tests need: it writes a valid document around rows a caller already
 * has, and is deliberately not a shipping publisher.
 */

/**
 * Where a snapshot is published.
 *
 * A bare string is the snapshot DOCUMENT itself, and choosing between mirrors
 * then reads only its first line (the head) before deciding whether to read on.
 * The object form adds an optional `head`: that same first line, published as
 * a small JSON document of its own (`SnapshotHead`), which is what a client
 * fetches to decide between mirrors before opening any body. That is the entity-path
 * counterpart of the free-form path's separate `lastSync` file, and it is
 * optional for the same reason it is there: a mirror that publishes only the
 * snapshot is still usable, it just costs a full download to compare.
 */
export type SnapshotLocation = string | {readonly url: string; readonly head?: string};

/** Which URL to ask for the selection metadata, and which for the payload. */
function urlsOf(location: SnapshotLocation): {head: string; body: string} {
	if (typeof location === 'string') return {head: location, body: location};
	return {head: location.head ?? location.url, body: location.url};
}

export type BootstrapOptions = {
	/**
	 * WHICH FOLD is about to index: the identity of the generation this store will
	 * belong to, as the deployment's ARRIVAL derived it (ADR-0086) -- the hash of the
	 * bundle's bytes where there are bytes.
	 *
	 * A snapshot from another processor is not a candidate: entity rows are the
	 * output of the processor that wrote them, so adopting them under different
	 * logic is adopting another program's conclusions. The value is COMPARED for
	 * equality and never parsed, so how either side derived one is nothing this
	 * module has an opinion about.
	 */
	readonly processor: string;
	/**
	 * The reorg depth this deployment protects against, in block numbers.
	 *
	 * When given, a snapshot taken INSIDE the reorg-eligible window (fewer than
	 * this many blocks behind the chain tip its producer had observed) is
	 * declined. A snapshot carries no history below its own block, so a reorg
	 * reaching under it cannot be undone at any cost, and the cheapest place to
	 * avoid that is to not adopt such a snapshot in the first place. The store
	 * still refuses the revert loudly if one arrives anyway
	 * (`RevertBeyondSnapshotError`); this is the half that stops it happening.
	 *
	 * Omitted means "trust the publisher took it far enough back", which is what
	 * the free-form path does implicitly.
	 */
	readonly finalityDepth?: number;
	/** Injectable for tests and for a host with its own retry/timeout policy. */
	readonly fetch?: typeof globalThis.fetch;
};

/** Why a bootstrap did not happen. Data, so a host can decide rather than parse a log. */
export type NotBootstrappedReason =
	/** No location was given at all. */
	| 'no-locations'
	/** Every location failed to FETCH. Transport, not content: the host did not answer. */
	| 'unreachable'
	/**
	 * Something WAS fetched and it is not a snapshot envelope this build reads.
	 *
	 * Deliberately distinct from `unreachable`, and it used to be folded into it
	 * (ADR-0071). The two have opposite remedies: a host that did not answer may
	 * answer on the next try, or another mirror may, so retrying is right; a
	 * document this build cannot read means the app or the publisher is out of date
	 * and retrying never helps. This is the reason an app renders to a user, so
	 * telling them "the mirror is down" about a version mismatch is the failure this
	 * outcome type exists to prevent.
	 *
	 * The stream-seed path, the deliberate analogue of this one, has split them
	 * since it was written (`NotInstalledReason`); this union simply drifted.
	 */
	| 'unreadable-format'
	/** Every reachable snapshot was computed by a different processor version. */
	| 'processor-mismatch'
	/** Every reachable snapshot was taken inside the reorg-eligible window. */
	| 'inside-reorg-window';

export type BootstrapOutcome =
	/** The snapshot and its cursor were installed; the store's state is as of `at` (the snapshot's `takenAt`). */
	| {readonly status: 'bootstrapped'; readonly at: number; readonly from: string}
	/**
	 * Nothing was installed because the local store had already got further.
	 *
	 * The free-form path's "prefer local" rule, and it matters more here: a
	 * snapshot BEHIND the local state would be a downgrade AND would drag the
	 * store's honest history floor up to the snapshot's block for no gain.
	 */
	| {readonly status: 'kept-local'; readonly at: number}
	| {readonly status: 'not-bootstrapped'; readonly reason: NotBootstrappedReason};

/**
 * The MINIMAL producer: a format-2 document around rows a caller already has.
 *
 * It exists so the consuming side can be tested against a real document rather
 * than a hand-written literal, and it is honest about being that. It cannot read
 * the rows out of a store for you, and the reason is structural rather than an
 * omission: the seam has no "list everything" read and deliberately never will
 * (a listing is anchored at a key prefix by construction, ADR-0021). The
 * producer that DOES read a whole state is a backend's own
 * (`produceStateSnapshot`, `@etherfold/state-store-sqlite`).
 *
 * The snapshot carries no history (`none`): its floor is `takenAt`, and `rows`
 * are the rows live there.
 */
export async function createSnapshot<ABI extends Abi>(snapshot: {
	/** The block the rows are the state AS OF. Its number becomes the consumer's history floor. */
	readonly takenAt: BlockPointer;
	/**
	 * The entities the rows belong to: the processor's declarations. A format-2
	 * document writes each once, and every row as its values in that column order.
	 */
	readonly entities: readonly EntityDeclaration[];
	/** The LIVE rows at that block, as the upserts that reproduce them. */
	readonly rows: Iterable<Mutation> | AsyncIterable<Mutation>;
	/** The cursor those rows belong to. Serialized here, installed with them as one unit. */
	readonly lastSync: LastSync<ABI>;
	/**
	 * WHICH FOLD computed the rows: its identity, compared for equality and never
	 * parsed.
	 *
	 * It is the identity the producing deployment's ARRIVAL derived and that its
	 * generation is REGISTERED under (ADR-0086) -- the SHA-256 of the bundle's
	 * octets where a deployment read one off disk -- and it is HANDED here rather
	 * than computed, because the bytes a fold ran are the producer's fact and not
	 * this module's. Take it from the fold that wrote these rows (the canonical
	 * generation's `processor`) rather than deriving it a second way beside it: a
	 * label that names an artifact other than the one that folded is the silent
	 * wrong-state condition ADR-0086 exists to delete, arriving at a client that
	 * cannot detect it -- a snapshot-seeded generation is a LEAF with no stream to
	 * re-fold and no way to recover by re-indexing.
	 */
	readonly processor: string;
	readonly savedAt?: string;
}): Promise<StateSnapshot> {
	const head: Omit<SnapshotHead, 'format'> = {
		processor: snapshot.processor,
		savedAt: snapshot.savedAt ?? new Date().toISOString(),
		takenAt: snapshot.takenAt,
		floor: snapshot.takenAt.number,
		cursor: {key: SYNC_CURSOR_KEY, value: serializeLastSync(snapshot.lastSync)},
	};
	const document = encodeSnapshot(head, snapshot.entities, [{block: snapshot.takenAt, mutations: snapshot.rows}]);
	return {
		head: {format: ENTITY_SNAPSHOT_FORMAT, ...head},
		document: new Uint8Array(await new Response(document).arrayBuffer()),
	};
}

/**
 * The chain tip the producer had observed when it took the snapshot, if its
 * cursor says so.
 *
 * `latestBlock` is the observed tip rather than progress through it, which is
 * exactly what the reorg-window check needs: how far BEHIND THE TIP the snapshot
 * was taken.
 */
function observedTip(head: SnapshotHead): number | undefined {
	if (!head.cursor) return undefined;
	return parseStoredCursor(head.cursor.value)?.latestBlock;
}

/**
 * How far the local store has already got, from the cursor it holds.
 *
 * `undefined` means it has never synced, which is the ordinary first-run case
 * and the one a bootstrap exists for.
 */
export async function localPosition(store: StateStore): Promise<number | undefined> {
	return parseStoredCursor(await store.readCursor(SYNC_CURSOR_KEY))?.lastToBlock;
}

/**
 * A mirror still in the running: its head, and -- when the head WAS the first line
 * of the body -- the body opened at that point, so the winner costs no second
 * request and a loser is cancelled rather than downloaded.
 */
type Candidate = {readonly location: SnapshotLocation; readonly head: SnapshotHead; readonly reader?: SnapshotReader};

/**
 * Bootstrap a store from the most advanced snapshot any of these locations has,
 * unless the store is already further along.
 *
 * ```ts
 * // `processorIdentity` is what the deployment's arrival derived and handed to its
 * // fold (ADR-0086), which is the one value naming this generation everywhere.
 * const store = await openSnapshotAware(await createBrowserStateStore(processor.entities));
 * const outcome = await bootstrapFromSnapshot(store, [
 *   'https://mirror-a.example/state.json',
 *   {url: 'https://mirror-b.example/state.json', head: 'https://mirror-b.example/head.json'},
 * ], {processor: processorIdentity, finalityDepth: 64});
 * ```
 *
 * The behaviour is the free-form keeper's, point for point: every location is
 * asked how far it has got, the furthest wins, an unreachable one is LOGGED and
 * skipped rather than thrown, and local state that is already ahead is kept. Two
 * differences, both deliberate:
 *
 * - **Failover walks every remaining candidate**, in descending order, where the
 *   free-form keeper tries the winner and then exactly one more (its own source
 *   says `// TODO more than 2`). With one mirror down and two up, this one gets
 *   state and that one does not.
 * - **A snapshot from another processor is not a candidate at all.** The
 *   free-form keeper does not check, which is the gap
 *   `processor-version-hash-cannot-silently-lie` closed on the CLI's envelope.
 *   Here it is decisive rather than advisory, because a mismatch means the rows
 *   were computed by different logic.
 *
 * Returning an OUTCOME rather than throwing on "nothing usable" is the same
 * judgement the free-form path makes: not finding a snapshot is a normal first
 * run in the wrong conditions, and the answer is to index from the start block.
 * What DOES throw is a snapshot that was selected and then turned out to be
 * unusable at install (`SnapshotProcessorMismatchError`, a document that breaks
 * its own shape), because that is a publisher contradicting its own head.
 *
 * ## The install streams
 *
 * The winner's body is inflated and installed as it downloads, a block at a time
 * (`SnapshotAwareStateStore.bootstrap`), so the whole document is never held. A
 * download that fails PART-WAY therefore throws rather than failing over, because
 * the install has started: for a snapshot without history that leaves only the
 * floor marker over an empty store, and the next boot (`openAndBootstrap`, which
 * finds no cursor) bootstraps again.
 */
export async function bootstrapFromSnapshot(
	store: SnapshotAwareStateStore,
	locations: SnapshotLocation | readonly SnapshotLocation[],
	options: BootstrapOptions,
): Promise<BootstrapOutcome> {
	const all = Array.isArray(locations) ? (locations as readonly SnapshotLocation[]) : [locations as SnapshotLocation];
	if (all.length === 0) return {status: 'not-bootstrapped', reason: 'no-locations'};

	const get = options.fetch ?? globalThis.fetch;
	const reasons = new Set<NotBootstrappedReason>();
	const candidates: Candidate[] = [];

	for (const location of all) {
		const {head: headUrl, body: bodyUrl} = urlsOf(location);
		const read = await readHead(get, headUrl, headUrl === bodyUrl);
		if (read.status !== 'read') {
			reasons.add(read.status);
			continue;
		}
		const {head, reader} = read;

		if (head.processor !== options.processor) {
			logger.warn(
				`ignoring the snapshot at ${headUrl}: it was computed by processor \`${head.processor}\` and this ` +
					`deployment runs \`${options.processor}\``,
			);
			await reader?.cancel();
			reasons.add('processor-mismatch');
			continue;
		}
		if (options.finalityDepth !== undefined && insideReorgWindow(head, options.finalityDepth)) {
			logger.warn(
				`ignoring the snapshot at ${headUrl}: it was taken at block ${head.takenAt.number}, within the ` +
					`${options.finalityDepth}-block reorg window of the tip its producer had seen (${observedTip(head)}). ` +
					`A snapshot carries no history below its own block, so a reorg reaching under it could not be undone.`,
			);
			await reader?.cancel();
			reasons.add('inside-reorg-window');
			continue;
		}

		candidates.push({location, head, reader});
	}

	if (candidates.length === 0) {
		return {status: 'not-bootstrapped', reason: pickReason(reasons)};
	}

	candidates.sort((a, b) => b.head.takenAt.number - a.head.takenAt.number);

	const local = await localPosition(store);
	if (local !== undefined && local >= candidates[0].head.takenAt.number) {
		logger.info(`keeping local state at block ${local}: no published snapshot is further along`);
		await cancelAll(candidates);
		return {status: 'kept-local', at: local};
	}

	for (const [index, candidate] of candidates.entries()) {
		const {body: bodyUrl} = urlsOf(candidate.location);
		let reader = candidate.reader;
		if (!reader) {
			try {
				reader = await readSnapshot(await bodyOf(await fetchOk(get, bodyUrl)));
			} catch (error) {
				logger.error(`could not open the snapshot at ${bodyUrl}, trying the next mirror`, error);
				continue;
			}
		}
		await cancelAll(candidates.slice(index + 1));
		await store.bootstrap(reader, {processor: options.processor});
		logger.info(`bootstrapped from ${bodyUrl} at block ${reader.head.takenAt.number}`);
		return {status: 'bootstrapped', at: reader.head.takenAt.number, from: bodyUrl};
	}

	return {status: 'not-bootstrapped', reason: 'unreachable'};
}

/**
 * Ask one location for its head: a separately published head document, or the
 * first line of the body itself.
 *
 * Transport and content stay apart (ADR-0071): a host that did not answer, or
 * answered with an error status, is `unreachable`; a document that arrived and is
 * not a format-2 head is `unreadable-format`.
 */
async function readHead(
	get: typeof globalThis.fetch,
	url: string,
	isBody: boolean,
): Promise<
	| {readonly status: 'read'; readonly head: SnapshotHead; readonly reader?: SnapshotReader}
	| {readonly status: 'unreachable' | 'unreadable-format'}
> {
	let response: Response;
	try {
		response = await fetchOk(get, url);
	} catch (error) {
		// logged and skipped, never thrown: one unreachable mirror must not
		// decide whether the app starts.
		logger.error(`could not read the snapshot head at ${url}`, error);
		return {status: 'unreachable'};
	}

	if (isBody) {
		try {
			const reader = await readSnapshot(await bodyOf(response));
			return {status: 'read', head: reader.head, reader};
		} catch (error) {
			if (!(error instanceof SnapshotFormatError)) {
				logger.error(`could not read the snapshot at ${url}`, error);
				return {status: 'unreachable'};
			}
			// REACHED, and unreadable. Not `unreachable`: the host answered.
			logger.error(`the snapshot at ${url} is not a document this build reads`, error);
			return {status: 'unreadable-format'};
		}
	}

	let head: unknown;
	try {
		head = await response.json();
	} catch {
		head = undefined;
	}
	if (!isReadableSnapshotHead(head)) {
		logger.error(`the snapshot head at ${url} is not a head this build reads`);
		return {status: 'unreadable-format'};
	}
	return {status: 'read', head};
}

/** Fetch, treating an error status as the host not answering with the document. */
async function fetchOk(get: typeof globalThis.fetch, url: string): Promise<Response> {
	const response = await get(url);
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response;
}

/** A response's body as a document: the stream when there is one, the bytes otherwise. */
async function bodyOf(response: Response): Promise<ReadableStream<Uint8Array> | Uint8Array> {
	return response.body ?? new Uint8Array(await response.arrayBuffer());
}

async function cancelAll(candidates: readonly Candidate[]): Promise<void> {
	await Promise.all(candidates.map((candidate) => candidate.reader?.cancel()));
}

/**
 * Open a store snapshot-aware and bootstrap it if it has never synced.
 *
 * The convenience the boot path of an app actually wants, and it exists to make
 * the SAFE order the short one: open through `openSnapshotAware` (which is what
 * recovers a floor recorded by a previous run) and only then decide whether to
 * fetch anything. A host that reached for `store.bootstrap` directly on a fresh
 * handle would get the floor right today and lose it on the next reload.
 *
 * A store that has already synced is left alone without a single request, which
 * is the common case on every run after the first.
 */
export async function openAndBootstrap(
	store: StateStoreBackend,
	locations: SnapshotLocation | readonly SnapshotLocation[],
	options: BootstrapOptions,
): Promise<{store: SnapshotAwareStateStore; outcome: BootstrapOutcome}> {
	const aware = await openSnapshotAware(store);
	const local = await localPosition(aware);
	if (local !== undefined) return {store: aware, outcome: {status: 'kept-local', at: local}};
	return {store: aware, outcome: await bootstrapFromSnapshot(aware, locations, options)};
}

/**
 * Whether the snapshot was taken close enough to its producer's tip that a reorg
 * could still reach under it.
 *
 * A producer that published no cursor said nothing about the tip it had seen, so
 * there is nothing to check and the snapshot is accepted: the check is a
 * safeguard against a careless publisher, not a proof of safety.
 */
function insideReorgWindow(head: SnapshotHead, finalityDepth: number): boolean {
	const tip = observedTip(head);
	if (tip === undefined) return false;
	return head.takenAt.number > tip - finalityDepth;
}

/** The most specific thing that went wrong, when several did. */
function pickReason(reasons: ReadonlySet<NotBootstrappedReason>): NotBootstrappedReason {
	// MOST SPECIFIC first: a reason about a document we actually read tells a user
	// more than one about a host that did not answer. `unreadable-format` sits above
	// `unreachable` for that reason and below the two content checks, which say
	// something sharper still about a document this build DID read.
	for (const reason of ['processor-mismatch', 'inside-reorg-window', 'unreadable-format', 'unreachable'] as const) {
		if (reasons.has(reason)) return reason;
	}
	return 'unreachable';
}
