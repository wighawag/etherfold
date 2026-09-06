import {logs} from 'named-logs';

const logger = logs('@etherfold/server');

/**
 * What a host's cursor reporter hands over: a SMALL, JSON-serialisable summary
 * of where the pipeline has got to.
 *
 * Typed as JSON rather than as `unknown` on purpose. The server reports this
 * VERBATIM (`/status` places it in the response and never parses it), so the
 * type is the only place the obligation can be stated at all -- and a `bigint`,
 * which is what a decoded `uint256` is throughout this project, would otherwise
 * compile here and then fail `JSON.stringify` on the one page an operator
 * refreshes while something is wrong.
 */
export type CursorReport =
	| string
	| number
	| boolean
	| null
	| readonly CursorReport[]
	| {readonly [key: string]: CursorReport};

/**
 * ONE GENERATION this host holds, as an operator reads it off `/status`.
 *
 * The GENERATION DIMENSION ADR-0047 reserved room for, and the smallest thing
 * that makes a rebuild in progress DISTINGUISHABLE from an empty result: an
 * indexer holds several generations, one of them answers reads, and a successor
 * catching up by re-folding the stored stream is neither finished nor missing.
 * Without this an operator watching a first build sees the same page as one
 * watching an indexer with nothing to do.
 *
 * The SHAPE is the server's and the CONTENTS are the host's, which is the same
 * division `value` already has one level up. Fixing every field but `value` is
 * what lets the field MEAN THE SAME THING across hosts -- and it is also where the
 * SIZE bound finally becomes structural rather than a plea in a doc comment,
 * because the only free-form part left is `value`, which owes exactly what the
 * top-level `value` owes.
 *
 * There is deliberately no CAP on how many of these a host may report: how many
 * generations an indexer accumulates is already bounded, loudly, by the
 * generation caps (`maxGenerations`, `@etherfold/core`), and a second bound here
 * would silently truncate a list an operator is reading to decide which
 * generation to delete.
 */
export type GenerationReport = {
	/**
	 * WHICH generation, as the OPAQUE digest every other surface advertises
	 * (`generationDigestOf`): compared and matched against the admin listing, never
	 * parsed.
	 */
	readonly generation: string;
	/** Whether the canonical pointer names it: the ONE generation that answers reads. */
	readonly canonical: boolean;
	/**
	 * Whether it is a FOLLOWER: a generation on a stream another one indexes, which
	 * catches up by RE-FOLDING the stored stream rather than from the wire.
	 *
	 * This is what says a REBUILD is what advances this entry, so `value` below is
	 * how far that rebuild has got. The established word (ADR-0044) rather than a
	 * second one meaning nearly the same thing.
	 */
	readonly follows: boolean;
	/**
	 * How far THIS generation's fold has got, in the same small summary the
	 * top-level `value` carries -- for a follower, that IS its rebuild checkpoint
	 * (ADR-0056: the checkpoint is the fold's own sync cursor and there is no second
	 * durable value).
	 *
	 * ABSENT rather than zeroed when the fold has committed nothing yet, which is
	 * exactly what a generation at the start of its rebuild looks like: a zero here
	 * would read as "synced to block 0".
	 */
	readonly value?: CursorReport;
};

/**
 * What a host's reporter hands over: the CONTENTS of the `cursor` envelope.
 *
 * TWO SLOTS, filled independently. `value` is where the generation that answers
 * READS has got to, which is the field every existing reader already reads.
 * `generations` is the per-generation dimension beside it (ADR-0047), and a host
 * may report either, both or neither.
 *
 * It is an explicit object rather than "the report, or a richer thing that looks
 * like one", because the server must not INSPECT what it was handed to find out
 * which it got: `value` is placed in the response verbatim and a host is free to
 * put a key called `generations` inside it. Sniffing would make a legal cursor
 * summary change how the envelope is built, which is precisely the parsing
 * ADR-0047 forbids.
 */
export type StatusReport = {
	/** Where the CANONICAL generation has got to. Reported verbatim; see `CursorReport`. */
	readonly value?: CursorReport;
	/** One entry per generation this host holds, oldest first. Omit it entirely to claim nothing. */
	readonly generations?: readonly GenerationReport[];
};

/**
 * A `GenerationReport` as the RESPONSE carries it, with `value` opaque.
 *
 * The same asymmetry `StatusCursor.value` has and for the same two reasons: it
 * is what the server actually knows, and a recursive JSON type reaching the Hono
 * RPC client type makes the compiler give up with `TS2589`.
 */
export type ReportedGeneration = {generation: string; canonical: boolean; follows: boolean; value?: unknown};

/**
 * The `cursor` field on `/status`: an ENVELOPE the server owns, around values it
 * does not understand.
 *
 * An OBJECT rather than the reported value itself, for two reasons that both
 * outlive this milestone. It carries the DEGRADED case in the field instead of
 * by omission, so an operator can tell "this host reports no cursor" from "this
 * host's reporter is broken". And it is where the GENERATION dimension GREW: a
 * host that reports several generations adds `generations` BESIDE `value`
 * rather than changing the type of a field clients already read (ADR-0047).
 *
 * `reported` keeps its exact original meaning -- IS THERE A CURSOR VALUE -- and
 * `generations` sits beside it on BOTH branches, because the two slots fail
 * independently. A first build is the case that makes that load-bearing: it
 * holds a generation and has folded nothing, so it has generations to report and
 * no cursor, and folding the two together would throw away the half that says
 * what is being built.
 *
 * `value` is typed `unknown` HERE and `CursorReport` at the injection point, and
 * the asymmetry is deliberate twice over. It is what the server actually knows
 * (it reports the value without parsing it), and this type reaches the Hono RPC
 * client type through `c.json`, where a recursive JSON type makes the compiler
 * give up with `TS2589` -- so the serialisability obligation is stated where a
 * HOST writes its reporter, which is the only place that can honour it anyway.
 */
export type StatusCursor =
	| {reported: true; value: unknown; generations?: readonly ReportedGeneration[]}
	| {reported: false; reason: string; generations?: readonly ReportedGeneration[]};

/**
 * Ask the host's reporter, and never let the answer fail the request.
 *
 * `/status` is the page an operator watches when something is wrong, so every
 * way a reporter can fail -- throwing, rejecting, having nothing to report, or
 * handing over something that cannot be serialised -- degrades to an
 * absent-with-a-reason cursor. Same rule the reorg counters follow in this
 * route, for the same reason: an operational read that could take the health
 * page down would be worse than no operational read.
 *
 * The serialisability probe is the one thing done TO the report, and it is not
 * parsing: it asks whether the report can be SENT, never what it means. Without
 * it an unserialisable report throws inside `c.json` -- after this function has
 * returned, where nothing can degrade it -- and the whole route answers `500`.
 * It probes the WHOLE report, so one unserialisable generation entry degrades
 * the envelope rather than the route.
 */
export async function reportCursor(
	report: () => StatusReport | undefined | Promise<StatusReport | undefined>,
): Promise<StatusCursor> {
	let reported: StatusReport | undefined;
	try {
		reported = await report();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.error(`status: the cursor reporter failed: ${reason}`);
		return {reported: false, reason};
	}

	if (reported === undefined) {
		return {reported: false, reason: `the cursor reporter has nothing to report`};
	}

	try {
		JSON.stringify(reported);
	} catch (err) {
		const reason = `the cursor report is not JSON-serialisable: ${err instanceof Error ? err.message : String(err)}`;
		logger.error(`status: ${reason}`);
		return {reported: false, reason};
	}

	// ABSENT means the host claimed nothing about its generations; an EMPTY LIST is
	// a claim ("this host holds none") and is carried as one. Same rule the `cursor`
	// field itself follows on a host that injects no reporter.
	const generations =
		reported.generations === undefined ? {} : {generations: reported.generations as readonly ReportedGeneration[]};

	if (reported.value === undefined) {
		return {
			reported: false,
			reason: `the cursor reporter named no cursor for the generation that answers reads`,
			...generations,
		};
	}

	return {reported: true, value: reported.value, ...generations};
}
