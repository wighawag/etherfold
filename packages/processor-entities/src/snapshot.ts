import type {Abi, LastSync} from '@etherfold/core';
import {
	openSnapshotAware,
	ENTITY_SNAPSHOT_FORMAT,
	type BlockPointer,
	type Mutation,
	type SnapshotAwareStateStore,
	type SnapshotHead,
	type StateSnapshot,
	type StateStore,
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
 * shape of what is downloaded (`StateSnapshot`, at the seam, whose payload is
 * the LIVE rows rather than one blob) and one thing the blob shape had no
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
 * It is not the publishing side. A snapshot as a first-class published artifact
 * -- who produces one and when, mirror layout and discovery, retention of old
 * snapshots, and who is allowed to publish state a client accepts without
 * recomputing -- is a design of its own
 * (`work/notes/ideas/publishing-snapshots-of-versioned-state.md`).
 * `createSnapshot` below is the MINIMAL producer this module's tests need, and
 * it is deliberately the smallest thing that can make a valid envelope rather
 * than a shipping publisher.
 */

/**
 * Where a snapshot is published.
 *
 * A bare string is the snapshot itself. The object form adds an optional `head`:
 * the same envelope WITHOUT its rows, which is what a client fetches to decide
 * between mirrors before downloading any of them. That is the entity-path
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
	 * The version hash of the processor about to index (`getVersionHash()`).
	 *
	 * A snapshot from another version is not a candidate: entity rows are the
	 * output of the processor that wrote them, so adopting them under different
	 * logic is adopting another program's conclusions.
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
	/** Rows and their cursor were installed; the store's history begins at `at`. */
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
 * The MINIMAL producer: an envelope around rows a caller already has.
 *
 * It exists so the consuming side can be tested against a real envelope rather
 * than a hand-written literal, and it is honest about being that. It cannot read
 * the rows out of a store for you, and the reason is structural rather than an
 * omission: the seam has no "list everything" read and deliberately never will
 * (a listing is anchored at a key prefix by construction, ADR-0021), so
 * enumerating a whole state needs either a ledger of the ids a run touched (what
 * `@etherfold/conformance-workload-stratagems` keeps) or a backend's own query
 * surface. Which of those a publisher uses is the publishing spec's business.
 */
export function createSnapshot<ABI extends Abi>(snapshot: {
	/** The block the rows are the state AS OF. Its number becomes the consumer's history floor. */
	readonly takenAt: BlockPointer;
	/** The LIVE rows at that block, as the upserts that reproduce them. */
	readonly rows: readonly Mutation[];
	/** The cursor those rows belong to. Serialized here, installed with them as one unit. */
	readonly lastSync: LastSync<ABI>;
	/** The version hash of the processor that computed the rows. */
	readonly processor: string;
	readonly savedAt?: string;
}): StateSnapshot {
	return {
		format: ENTITY_SNAPSHOT_FORMAT,
		processor: snapshot.processor,
		savedAt: snapshot.savedAt ?? new Date().toISOString(),
		takenAt: snapshot.takenAt,
		cursor: {key: SYNC_CURSOR_KEY, value: serializeLastSync(snapshot.lastSync)},
		rows: snapshot.rows,
	};
}

/** The same envelope without its payload: what a mirror publishes for selection. */
export function snapshotHead(snapshot: StateSnapshot): SnapshotHead {
	const {rows: _rows, ...head} = snapshot;
	return head;
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

type Candidate = {readonly location: SnapshotLocation; readonly head: SnapshotHead; readonly body?: StateSnapshot};

/**
 * Bootstrap a store from the most advanced snapshot any of these locations has,
 * unless the store is already further along.
 *
 * ```ts
 * const store = await openSnapshotAware(await createBrowserStateStore(processor.entities));
 * const outcome = await bootstrapFromSnapshot(store, [
 *   'https://mirror-a.example/state.json',
 *   {url: 'https://mirror-b.example/state.json', head: 'https://mirror-b.example/head.json'},
 * ], {processor: eventProcessor.getVersionHash(), finalityDepth: 64});
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
 * - **A snapshot from another processor version is not a candidate at all.** The
 *   free-form keeper does not check, which is the gap
 *   `processor-version-hash-cannot-silently-lie` closed on the CLI's envelope.
 *   Here it is decisive rather than advisory, because a version mismatch means
 *   the rows describe different entities.
 *
 * Returning an OUTCOME rather than throwing on "nothing usable" is the same
 * judgement the free-form path makes: not finding a snapshot is a normal first
 * run in the wrong conditions, and the answer is to index from the start block.
 * What DOES throw is a snapshot that was selected and then turned out to be
 * unusable at install (`SnapshotProcessorMismatchError`, `SnapshotFormatError`),
 * because that is a publisher contradicting its own head.
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
		let fetched: StateSnapshot | SnapshotHead;
		try {
			fetched = (await (await get(headUrl)).json()) as StateSnapshot | SnapshotHead;
		} catch (error) {
			// logged and skipped, never thrown: one unreachable mirror must not
			// decide whether the app starts.
			logger.error(`could not read the snapshot head at ${headUrl}`, error);
			reasons.add('unreachable');
			continue;
		}

		if (!isReadableHead(fetched)) {
			// REACHED, and unreadable. Not `unreachable`: the host answered.
			logger.error(`the snapshot head at ${headUrl} is not an envelope this build reads`);
			reasons.add('unreadable-format');
			continue;
		}
		if (fetched.processor !== options.processor) {
			logger.warn(
				`ignoring the snapshot at ${headUrl}: it was computed by processor \`${fetched.processor}\` and this ` +
					`deployment runs \`${options.processor}\``,
			);
			reasons.add('processor-mismatch');
			continue;
		}
		if (options.finalityDepth !== undefined && insideReorgWindow(fetched, options.finalityDepth)) {
			logger.warn(
				`ignoring the snapshot at ${headUrl}: it was taken at block ${fetched.takenAt.number}, within the ` +
					`${options.finalityDepth}-block reorg window of the tip its producer had seen (${observedTip(fetched)}). ` +
					`A snapshot carries no history below its own block, so a reorg reaching under it could not be undone.`,
			);
			reasons.add('inside-reorg-window');
			continue;
		}

		// when the head URL IS the snapshot URL, the payload is already in hand and
		// the winner costs no second request.
		const body = headUrl === bodyUrl && 'rows' in fetched ? (fetched as StateSnapshot) : undefined;
		candidates.push({location, head: fetched, body});
	}

	if (candidates.length === 0) {
		return {status: 'not-bootstrapped', reason: pickReason(reasons)};
	}

	candidates.sort((a, b) => b.head.takenAt.number - a.head.takenAt.number);

	const local = await localPosition(store);
	if (local !== undefined && local >= candidates[0].head.takenAt.number) {
		logger.info(`keeping local state at block ${local}: no published snapshot is further along`);
		return {status: 'kept-local', at: local};
	}

	for (const candidate of candidates) {
		const {body: bodyUrl} = urlsOf(candidate.location);
		let snapshot = candidate.body;
		if (!snapshot) {
			try {
				snapshot = (await (await get(bodyUrl)).json()) as StateSnapshot;
			} catch (error) {
				logger.error(`could not download the snapshot at ${bodyUrl}, trying the next mirror`, error);
				continue;
			}
		}
		await store.bootstrap(snapshot, {processor: options.processor});
		logger.info(`bootstrapped from ${bodyUrl} at block ${snapshot.takenAt.number}`);
		return {status: 'bootstrapped', at: snapshot.takenAt.number, from: bodyUrl};
	}

	return {status: 'not-bootstrapped', reason: 'unreachable'};
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
	store: StateStore,
	locations: SnapshotLocation | readonly SnapshotLocation[],
	options: BootstrapOptions,
): Promise<{store: SnapshotAwareStateStore; outcome: BootstrapOutcome}> {
	const aware = await openSnapshotAware(store);
	const local = await localPosition(aware);
	if (local !== undefined) return {store: aware, outcome: {status: 'kept-local', at: local}};
	return {store: aware, outcome: await bootstrapFromSnapshot(aware, locations, options)};
}

function isReadableHead(value: unknown): value is SnapshotHead {
	const head = value as SnapshotHead | undefined;
	return (
		!!head &&
		head.format === ENTITY_SNAPSHOT_FORMAT &&
		typeof head.processor === 'string' &&
		typeof head.takenAt?.number === 'number'
	);
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
