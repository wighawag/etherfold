import type {
	Abi,
	GenerationRecord,
	HeldGeneration,
	Indexer,
	IndexingSource,
	LastSync,
	TxInclusionQuery,
	TxInclusionVerdict,
	UsedPromotionConfig,
} from '@etherfold/core';
import {sameGeneration} from '@etherfold/core';
import {declaredRow, mustGet, type Listing, type NormalizedEntity, type StateStore} from '@etherfold/state-store';
import {logs} from 'named-logs';
import {assertClonable} from './clone.js';
import {listen, type HostAccess} from './endpoint.js';
import {
	INDEXER_PORT_PROTOCOL,
	isPortRequest,
	type HostGeneration,
	type HostProgress,
	type HostReconfigure,
	type PortCases,
	type PortPush,
	type PortRequest,
	type PortResponse,
	type PortRow,
} from './envelope.js';
import {portErrorOf} from './errors.js';

const namedLogger = logs('@etherfold/browser');

/**
 * WHAT EVERY HOSTING SHAPE RUNS: the envelope, the cases, the push cadence.
 *
 * This module is the answer to ADR-0082's opening claim -- "one body running in
 * every hosting shape", so that a dedicated worker, a SharedWorker and the main
 * thread do not become three implementations. It is not a claim two files can
 * make by agreeing on inspection, so it is made structurally: the switch below is
 * the ONLY place a `PortCases` key is served, the projections below are the only
 * place a row is shaped for the wire, and the derivations below are the only
 * place a progress figure is computed. Every shape reaches them.
 *
 * ## What is shared, and what is honestly NOT
 *
 * Shared: everything a TAB can observe. The request/response envelope, the
 * correlation, the clone refusals, the case dispatch, the row projection, the
 * derived progress figures, the subscribe/unsubscribe bookkeeping and the rule
 * that an unchanged report is not posted.
 *
 * Not shared: the DRIVER. `serve.ts` opens a container and advances it in a loop
 * of its own; `createIndexerState` -- which IS the main-thread host (ADR-0082) --
 * has driven its container through an auto-index loop with four verbs since long
 * before this port existed. Both satisfy `HostBacking` below and neither is
 * expressed in terms of the other, so what "one implementation" means precisely
 * is: one implementation of the BOUNDARY, over two drivers. See the module note
 * in `mainThread.ts` for why the second one was kept rather than folded into the
 * first.
 */

/**
 * WHAT A HOST MUST BE ABLE TO ANSWER, for the cases below to serve it.
 *
 * Deliberately the smallest thing that spans the surface: nine questions, no
 * lifecycle, no endpoint, no knowledge of workers. A shape's host implements it
 * over whatever it drives; the case dispatch never learns which.
 */
export type HostBacking = {
	/** How far the fold has got, as this host reports it. */
	progress(): HostProgress;
	/** Start the driver, and answer where the fold is. Idempotent: it names a STATE, not an edge. */
	startIndexing(): Promise<HostProgress>;
	/** Stop the driver once the cycle in flight has LANDED, and answer where it stopped. */
	stopIndexing(): Promise<HostProgress>;
	/** Fold a new source in a generation BESIDE the live one. */
	reconfigure(source: IndexingSource<Abi>): Promise<HostReconfigure>;
	/** Every generation this host holds, with the one answering reads marked. */
	generations(): readonly HostGeneration[];
	/** The promotion policy in force, as the container that APPLIES it resolved it. */
	promotion(): Promise<UsedPromotionConfig>;
	/** Does the state this host is folding into already account for these transactions? */
	checkTxInclusion(queries: readonly TxInclusionQuery[]): Record<string, TxInclusionVerdict>;
	/**
	 * The store a read is answered from: the one the CANONICAL generation folds
	 * into.
	 *
	 * It may WAIT -- a read that arrives before the first store exists is answered
	 * late rather than refused, because "read me the rows" has no honest answer
	 * until there is a store. What it must never do is wait for ever: a host that
	 * stopped before it built one REJECTS, since a hung promise is the worst
	 * available outcome (ADR-0082).
	 */
	storeForReads(): Promise<StateStore>;
};

/** What a shape's host holds of the cases it is being served through. */
export type ServedCases = {
	/**
	 * POST THE PROGRESS, if anybody asked for it and if it MOVED.
	 *
	 * Called by a host wherever it applied work or changed phase, and never on a
	 * timer. An UNCHANGED value is not posted at all: a host resting at the tip
	 * advances every few seconds and applies nothing, so posting there would turn
	 * the signal back into the polling it replaced with the cost merely moved to
	 * the other end of the wire.
	 */
	publish(): void;
	/** Stop listening and forget every subscription. A stopped serving answers nothing ever again. */
	stop(): void;
};

/**
 * SERVE THE PORT'S CASES OVER ONE WIRE, from one backing.
 *
 * Returns as soon as it is listening. It knows nothing about workers, nothing
 * about containers and nothing about drivers: it is handed a `HostAccess` (a
 * wire plus the name of the shape that produced it) and a `HostBacking`, and
 * everything between them is the same code in every shape.
 */
export function serveHostCases(access: HostAccess, backing: HostBacking): ServedCases {
	/** THE SERVING IS FINISHED: stopped, and answering nothing ever again. */
	let stopped = false;
	/**
	 * HOW MANY SUBSCRIPTIONS this endpoint holds, so that nothing is posted to a
	 * tab that did not ask and a second listener does not silence the first.
	 *
	 * A COUNT rather than a flag: a tab's port asks once for its first listener and
	 * releases once for its last, but a host answers whoever is on its endpoint and
	 * must not be made incoherent by one that asks twice.
	 */
	let subscriptions = 0;
	/** The last value POSTED, so an unchanged one is not posted again. */
	let published: HostProgress | undefined;

	function publish(): void {
		if (stopped || subscriptions === 0) return;
		const current = backing.progress();
		if (published && sameProgress(published, current)) return;
		published = current;
		const push: PortPush<'progress'> = {
			protocol: INDEXER_PORT_PROTOCOL,
			kind: 'push',
			push: 'progress',
			value: current,
		};
		try {
			assertClonable(current, `the 'progress' push`);
			access.endpoint.postMessage(push);
		} catch (error) {
			// Nobody is waiting on a push, so there is no call to reject: it is logged
			// rather than swallowed, so a host that cannot talk is visible in a console.
			namedLogger.error(`the indexer host could not post its 'progress' push`, error);
		}
	}

	/**
	 * ONE READ, projected to the DECLARED columns before it crosses.
	 *
	 * Projected HERE, by the same `declaredRow` the same-thread surface uses, which
	 * is what makes "the rows are identical" one implementation rather than several
	 * that agree by inspection: the version columns never leave the host, and an
	 * unlisted declared field crosses as `null` exactly as the store wrote it.
	 *
	 * An entity the store was not built with is refused by `mustGet`, which every
	 * backend already raises through, so the refusal a tab gets is the refusal a
	 * same-thread caller gets (`UnknownEntityError`, named so it survives the
	 * crossing as something an app can act on).
	 */
	async function served<T>(
		entityName: string,
		read: (store: StateStore, entity: NormalizedEntity) => Promise<T>,
	): Promise<T> {
		const store = await backing.storeForReads();
		return read(store, mustGet(store.declarations, entityName));
	}

	/**
	 * THE CASES, and the switch every later surface extends.
	 *
	 * Async because most of what is on it is: the store's four reads and every
	 * control call return promises.
	 */
	async function serveCase(request: PortRequest): Promise<unknown> {
		switch (request.case) {
			case 'progress':
				return backing.progress();
			case 'ping':
				// ANSWERING IS THE WHOLE ANSWER. A tab probes a host that has gone quiet,
				// and what it is asking for is evidence that anything is still running here
				// -- so this reads nothing, computes nothing and waits for nothing. It must
				// never grow a body: a probe that opened the container would make a host
				// look dead exactly while it was busiest.
				return undefined;
			case 'subscribeToProgress': {
				subscriptions++;
				const current = backing.progress();
				// Recorded as published, so the first PUSH a new subscriber gets is a
				// CHANGE rather than a repeat of the answer it is about to be handed.
				published = current;
				return current;
			}
			case 'startIndexing':
				return backing.startIndexing();
			case 'stopIndexing':
				return backing.stopIndexing();
			case 'reconfigure': {
				const asked = request.payload as PortCases['reconfigure']['request'];
				return backing.reconfigure(asked.source);
			}
			case 'generations':
				return backing.generations();
			case 'promotion':
				return backing.promotion();
			case 'checkTxInclusion': {
				const asked = request.payload as PortCases['checkTxInclusion']['request'];
				return backing.checkTxInclusion(asked.queries);
			}
			case 'unsubscribeFromProgress':
				subscriptions = Math.max(0, subscriptions - 1);
				// What was last posted is forgotten with the last subscriber: the next one
				// is told where the fold is by its own subscribe, and comparing against a
				// value nobody on this endpoint ever received would suppress a real change.
				if (subscriptions === 0) published = undefined;
				return undefined;
			case 'declarations':
				return [...(await backing.storeForReads()).declarations.values()];
			case 'getCurrent': {
				const asked = request.payload as PortCases['getCurrent']['request'];
				return served(asked.entity, async (store, entity) =>
					projected(entity, await store.getCurrent(entity.name, asked.id)),
				);
			}
			case 'getAsOf': {
				const asked = request.payload as PortCases['getAsOf']['request'];
				return served(asked.entity, async (store, entity) =>
					projected(entity, await store.getAsOf(entity.name, asked.id, asked.at)),
				);
			}
			case 'listCurrent': {
				const asked = request.payload as PortCases['listCurrent']['request'];
				return served(asked.entity, async (store, entity) =>
					listed(entity, await store.listCurrent(entity.name, asked.prefix, asked.limit)),
				);
			}
			case 'listAsOf': {
				const asked = request.payload as PortCases['listAsOf']['request'];
				return served(asked.entity, async (store, entity) =>
					listed(entity, await store.listAsOf(entity.name, asked.prefix, asked.at, asked.limit)),
				);
			}
			default:
				throw new Error(
					`this indexer host does not know the case '${String((request as {case: string}).case)}'. A tab and its ` +
						`host come out of one build, so this means they did not.`,
				);
		}
	}

	function respond(response: PortResponse): void {
		try {
			access.endpoint.postMessage(response);
		} catch (error) {
			// Nothing is left to answer WITH: the answer itself is what could not be
			// posted. It is logged rather than swallowed so a host that cannot talk is
			// visible in a console, and the tab's call is left to the port's own
			// lifetime handling.
			namedLogger.error(`the indexer host could not post its '${response.case}' response`, error);
		}
	}

	async function answer(request: PortRequest): Promise<void> {
		const envelope = {protocol: INDEXER_PORT_PROTOCOL, kind: 'response', id: request.id, case: request.case} as const;
		let value: unknown;
		try {
			value = await serveCase(request);
			// REFUSED HERE, where the value was written, rather than thrown out of
			// `postMessage` where nothing knows which field it was. The refusal is
			// still an ANSWER to the tab's call: a caller that asked a question gets a
			// rejection naming the field, not a promise that never settles.
			assertClonable(value, `the '${request.case}' response`);
		} catch (error) {
			respond({...envelope, ok: false, error: portErrorOf(error)});
			return;
		}
		respond({...envelope, ok: true, value} as PortResponse);
	}

	const stopListening = listen(access.endpoint, (data) => {
		// Not ours: a shared scope carries whatever anybody posts to it, and a
		// message from somebody else is not an unknown case.
		if (!isPortRequest(data)) return;
		if (stopped) return;
		void answer(data);
	});

	return {
		publish,
		stop() {
			stopped = true;
			subscriptions = 0;
			published = undefined;
			stopListening();
		},
	};
}

const projected = (entity: NormalizedEntity, raw: PortRow | undefined): PortRow | undefined =>
	raw === undefined ? undefined : declaredRow(entity, raw);

const listed = (entity: NormalizedEntity, found: Listing<PortRow>): Listing<PortRow> => ({
	rows: found.rows.map((raw) => declaredRow(entity, raw)),
	truncated: found.truncated,
});

/**
 * THE FIGURES AN APP RENDERS, derived where the cursor is.
 *
 * The three `createIndexerState` computes for its own reactive triple
 * (`ExtendedLastSync`), computed HERE for every shape so that an app moving
 * between them binds the same names to the same meanings and so that the two
 * cannot drift.
 *
 * ## The guard, and what it is guarding against
 *
 * Every figure here is a distance to a TIP, and a container that has loaded and
 * not yet fetched publishes `0` for both cursors: it has learnt no tip. So they
 * are absent together below `latestBlock > 0` rather than computed from a number
 * that does not mean what it looks like -- the alternative is an app told it is
 * `0` blocks behind, and a full progress bar, before a single log was asked for.
 *
 * ## What was deliberately left behind
 *
 * `ExtendedLastSync.totalPercentage` (`lastToBlock / latestBlock`) does not
 * cross. It measures the fold against the whole CHAIN rather than against the
 * span it indexes, so a deployment whose contract starts at block 20,000,000
 * reads 99.9% from its first fetch, which is not a thing to put on a progress
 * bar. `syncPercentage` is the one with a denominator an app means.
 */
export function derivedProgress<ABI extends Abi>(
	lastSync: LastSync<ABI>,
	foldStartsAt: number,
): Pick<HostProgress, 'blocksBehindTip' | 'numBlocksProcessedSoFar' | 'syncPercentage'> {
	const {lastToBlock, latestBlock} = lastSync;
	if (latestBlock <= 0) return {};
	const numBlocksProcessedSoFar = Math.max(0, lastToBlock - foldStartsAt);
	const totalToProcess = Math.max(0, latestBlock - foldStartsAt);
	return {
		blocksBehindTip: Math.max(0, latestBlock - lastToBlock),
		numBlocksProcessedSoFar,
		// A fold with no span to cross is DONE rather than a division by zero.
		syncPercentage:
			totalToProcess === 0
				? 100
				: Math.min(100, Math.floor((numBlocksProcessedSoFar * 1000000) / totalToProcess) / 10000),
	};
}

/**
 * WHETHER TWO REPORTS SAY THE SAME THING, which is how a push that carries no
 * news is suppressed.
 *
 * Field by field rather than by serialising both, because the equality is the
 * one this decides on: `failure` is compared on what a tab acts on (its name and
 * its message) and never on the host's stack, which is a string the same failure
 * can spell differently and which nothing renders.
 */
export function sameProgress(a: HostProgress, b: HostProgress): boolean {
	return (
		a.host === b.host &&
		a.scope === b.scope &&
		a.indexing === b.indexing &&
		a.phase === b.phase &&
		a.lastToBlock === b.lastToBlock &&
		a.latestBlock === b.latestBlock &&
		a.blocksBehindTip === b.blocksBehindTip &&
		a.numBlocksProcessedSoFar === b.numBlocksProcessedSoFar &&
		a.syncPercentage === b.syncPercentage &&
		a.failure?.name === b.failure?.name &&
		a.failure?.message === b.failure?.message
	);
}

/**
 * EVERY GENERATION A CONTAINER HOLDS, as the port reports them.
 *
 * Read afresh per call rather than accumulated, exactly as `createIndexerState`
 * derives `nonCanonicalGenerations`: the container already keeps every
 * generation's cursor (its promotion trigger is a comparison between two of
 * them), and a copy would be a second thing to keep true across a promotion, a
 * revert and a drop.
 */
export function hostGenerationsOf<ABI extends Abi, ProcessResultType>(
	container: Indexer<ABI, ProcessResultType>,
): readonly HostGeneration[] {
	return container.generations.map((generation) => hostGenerationOf(generation, container));
}

/** ONE generation, with the canonical flag and the two distances a tab renders. */
export function hostGenerationOf<ABI extends Abi, ProcessResultType>(
	generation: HeldGeneration<ABI, ProcessResultType>,
	container: Indexer<ABI, ProcessResultType>,
): HostGeneration {
	const canonical: GenerationRecord = container.canonical.record;
	const canonicalCursor = container.generations.find((other) => sameGeneration(other.record, canonical))?.lastSync
		?.lastToBlock;
	const lastToBlock = generation.lastSync?.lastToBlock;
	return {
		record: generation.record,
		canonical: sameGeneration(generation.record, canonical),
		follows: generation.follows,
		...(lastToBlock === undefined ? {} : {lastToBlock}),
		// Floored at zero: a generation AHEAD of the canonical one (which `manual`
		// allows) is not behind by a negative number, it is not behind.
		...(lastToBlock === undefined || canonicalCursor === undefined
			? {}
			: {blocksBehind: Math.max(0, canonicalCursor - lastToBlock)}),
	};
}
