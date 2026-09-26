import {generationDigestOf, sameGeneration, type GenerationFolding, type GenerationId} from '@etherfold/core';
import {parseStoredCursor, SYNC_CURSOR_KEY, type StateStore} from '@etherfold/processor-entities';
import type {CanonicalReport, GenerationReport, StatusReport, WaitingReport} from '@etherfold/server';
import {logs} from 'named-logs';

const logger = logs('etherfold');

/**
 * What a command that OWNS a store tells `/status` about where its pipeline has
 * got to.
 *
 * ## Why this is a summary and not the cursor
 *
 * The **sync cursor** is an opaque string behind the storage seam (ADR-0027),
 * and what that string holds is a serialized `LastSync` carrying
 * `unconfirmedBlocks`: whole blocks of DECODED events, every `uint256` of them a
 * `bigint`. The server reports whatever a reporter hands it VERBATIM -- it does
 * not parse it, so it cannot bound it afterwards either (ADR-0047) -- so handing
 * the cursor over whole would put an unbounded blob of event data on the one
 * page an operator refreshes while something is wrong, and would fail
 * `JSON.stringify` on the first `uint256` it met.
 *
 * So the four numbers below, and nothing else. They are chosen to answer the two
 * questions a status page is asked: **is it moving** (`lastToBlock` across two
 * reads) and **how far behind is it** (`latestBlock - lastToBlock`).
 * `unconfirmedBlocks` is a COUNT rather than the window itself, for the reason
 * above -- the window is the blob.
 *
 * What is deliberately NOT here: the `context` hashes (an identity, not a
 * progress report; a reader comparing them wants the wire, not `/status`) and
 * anything the store computes on demand, since a reporter runs on every
 * `/status` and must stay one cursor read.
 */
export type StoreCursorReport = {
	/** The first block of the last range that was applied. */
	lastFromBlock: number;
	/** How far the fold has got: the number that ADVANCES while a run makes progress. */
	lastToBlock: number;
	/** The chain tip observed when that range was applied, so a reader can see the lag. */
	latestBlock: number;
	/** How many blocks are still reorg-eligible. A COUNT: the window itself is the blob. */
	unconfirmedBlocks: number;
};

/**
 * Read the store's cursor and summarise it, or report nothing.
 *
 * `undefined` is the honest answer before the first block lands: there is no
 * cursor yet, and `/status` says so with a reason rather than inventing a zero
 * that reads like "synced to block 0". An unparseable cursor answers the same
 * way, because `parseStoredCursor` treats one as never-synced -- which is what
 * the fold itself does with it.
 */
export async function readCursorReport(store: StateStore): Promise<StoreCursorReport | undefined> {
	const lastSync = parseStoredCursor(await store.readCursor(SYNC_CURSOR_KEY));
	if (!lastSync) return undefined;
	return {
		lastFromBlock: lastSync.lastFromBlock,
		lastToBlock: lastSync.lastToBlock,
		latestBlock: lastSync.latestBlock,
		unconfirmedBlocks: lastSync.unconfirmedBlocks.length,
	};
}

/**
 * ONE FOLD this host holds, as the reporter reads it.
 *
 * A LIST of these is what a host hands over, even where the list has one entry,
 * because the shape of `/status` must not depend on how many generations a
 * deployment happens to hold: a `run` holding one and a host mid-upgrade holding
 * two report the same field with a different number of entries in it.
 */
export type ReportedFold = {
	/**
	 * WHICH generation this fold is, read at the moment of asking.
	 *
	 * Derived on the call and never captured, exactly as the registry entry derives
	 * `canonicalGeneration`: a processor's version hash is read when it is asked for,
	 * and a value captured at start-up can stop being true.
	 */
	generation: GenerationId;
	/** The store it folds into -- its own table namespace (ADR-0053) -- where its cursor lives. */
	store: StateStore;
	/**
	 * Whether it is a FOLLOWER: advanced by a REBUILD over the stored stream rather
	 * than by the wire (ADR-0044).
	 *
	 * Absent means no. It stays OPTIONAL although this package's only producer sets
	 * it on every fold -- under ADR-0087 no generation fetches, so on a receiving
	 * deployment there is one shape of fold and it is this one -- because the
	 * reporter is the seam a host fills in and a host that holds both shapes is what
	 * the field is for.
	 */
	follows?: boolean;
};

/**
 * WHAT THIS HOST CAN SAY ABOUT WHERE IT HAS GOT TO: the canonical generation's
 * cursor, one entry per generation held, and the canonical generation named on its
 * own whether or not it is held.
 *
 * The reporter `/status` is injected with (ADR-0047). It fills the envelope's
 * slots from the SAME reads: every fold's cursor is read once, the canonical
 * one's answer is also the top-level `value` and the canonical report's, and
 * nothing is computed on demand -- a reporter runs on every `/status`, so it stays
 * one cursor read per generation and the generation caps bound how many that is.
 *
 * ## Why a fold that cannot be read is still an ENTRY
 *
 * A generation reports NO `value` rather than dropping out of the list when its
 * cursor cannot be read, and the ordinary reason is the one this whole task
 * exists for: a successor at the start of its rebuild has committed nothing, so
 * its namespace may not have a row -- or a table -- to read yet. Reporting a zero
 * would read as "synced to block 0" and dropping the entry would hide the very
 * generation an operator opened the page to watch, so the honest answer is "this
 * one is here, and it has not got anywhere yet".
 *
 * A read that FAILS is treated the same way and said out loud in the log,
 * deliberately: one generation's unreadable store must not cost an operator the
 * other entries, on the page they are looking at because something is wrong.
 *
 * ## Why the canonical generation is reported even when nothing here HOLDS it
 *
 * `generations` is what this host HOLDS, and it keeps that meaning (ADR-0047). A
 * canonical generation nothing here folds -- stored code that could not be built,
 * a revert across a filter change (ADR-0092) -- is therefore not in it, and before
 * the `canonical` report the page then had no `value` and no word about why. So the
 * canonical generation alone is read from its OWN state (`canonicalState`, built
 * unclaimed over its namespace, ADR-0053) with no engine, and reported beside the
 * list with the admin listing's `folding` answer for it. ONE extra read, and only
 * when the canonical generation is not held; never one per registered generation.
 */
export async function readStatusReport(held: {
	/** Every fold this host holds, oldest first -- the order the registry lists them in. */
	folds: readonly ReportedFold[];
	/** WHICH generation answers reads, or nothing on a host that holds no pointer. */
	canonical?: GenerationId;
	/**
	 * WHETHER the canonical generation can fold here, in the admin listing's words
	 * (`ReceivingIndexer.foldingOf`, ADR-0092). Absent where the host cannot say, and
	 * then the report says nothing about it rather than guessing.
	 */
	canonicalFolding?: GenerationFolding;
	/**
	 * The canonical generation's OWN state, to read its position from where no held
	 * fold is it: its namespace, UNCLAIMED, so reading never takes the claim from a
	 * writer. Consulted only when the canonical generation is not held.
	 */
	canonicalState?: StateStore;
	/** Present exactly while the host is WAITING for a processor (ADR-0093), and reported verbatim. */
	waiting?: WaitingReport;
}): Promise<StatusReport> {
	const generations: GenerationReport[] = [];
	let value: StoreCursorReport | undefined;
	let canonicalHeld = false;
	for (const fold of held.folds) {
		const canonical = !!held.canonical && sameGeneration(fold.generation, held.canonical);
		const report = await progressOf(fold);
		if (canonical) {
			value = report;
			canonicalHeld = true;
		}
		generations.push({
			generation: generationDigestOf(fold.generation),
			canonical,
			follows: !!fold.follows,
			...(report === undefined ? {} : {value: report}),
		});
	}
	// NOTHING HERE FOLDS IT: its position is still a row in its own namespace, read
	// with no engine, exactly as the promotion trigger reads it (ADR-0084).
	if (held.canonical && !canonicalHeld && held.canonicalState) {
		value = await progressOf({generation: held.canonical, store: held.canonicalState});
	}
	return {
		...(value === undefined ? {} : {value}),
		generations,
		...(held.canonical ? {canonical: canonicalReportOf(held.canonical, held.canonicalFolding, value)} : {}),
		...(held.waiting === undefined ? {} : {waiting: held.waiting}),
	};
}

/**
 * The canonical report: the digest, the `folding` answer in the admin listing's shape
 * (`frozen` carries the reason only where it is frozen, so a caller branches on one
 * string), and where it stands.
 */
function canonicalReportOf(
	canonical: GenerationId,
	folding: GenerationFolding | undefined,
	value: StoreCursorReport | undefined,
): CanonicalReport {
	const answer = folding && sameGeneration(folding.generation, canonical) ? folding : undefined;
	return {
		generation: generationDigestOf(canonical),
		...(answer === undefined
			? {}
			: answer.folding === 'frozen'
				? {folding: 'frozen', frozen: {reason: answer.frozen.reason, message: answer.frozen.message}}
				: {folding: answer.folding}),
		...(value === undefined ? {} : {value}),
	};
}

/** How far one fold has got, or nothing at all -- never a failure the page pays for. */
async function progressOf(fold: ReportedFold): Promise<StoreCursorReport | undefined> {
	try {
		return await readCursorReport(fold.store);
	} catch (err) {
		logger.error(
			`status: the cursor of the generation ${generationDigestOf(fold.generation)} could not be read, so it is ` +
				`reported with no progress rather than left out of the listing`,
			err,
		);
		return undefined;
	}
}
