import type {Abi} from 'abitype';
import {openIndexer, type AnyGenerationSpec, type Indexer} from '../../src/container.js';
import {generationDigestOf} from '../../src/generation/identity.js';
import {openMemoryGenerationRegistry} from '../../src/generation/memory.js';
import type {PromotionPolicy} from '../../src/generation/promotion.js';
import {IndexerGeneration} from '../../src/indexer.js';
import type {StateApplied, StateMoved} from '../../src/stateMoved.js';
import type {EventProcessor, FoldReporter, LogEvent} from '../../src/types.js';
import {BRANCH_A, fakeChain, FINALITY, makeLog, memoryStream, SOURCE} from './streamCacheWorld.js';

/**
 * The world the SIGNAL's container tests drive: the real container over the
 * stream-cache world's fake chain, with a fold that REPORTS what it did and an
 * in-process subscriber attached.
 *
 * It lives beside the tests rather than inside one because two files ask the
 * same questions of it -- what a container publishes for an ordinary append, and
 * what it publishes when the chain reorgs underneath the same fold -- and a
 * second copy of the fold would be a second definition of what the layer below
 * reports, which is the only thing either file's claims can be made against.
 *
 * What it is NOT is a substitute for the real fold. The ENTITY NAMES and the
 * FORK POINT a reader is told about are produced one package down, from real
 * mutations and real `removed` markers, and they are asserted where they are
 * produced (`@etherfold/conformance-workload-stratagems`). What is asserted HERE
 * is the container's half: which reports become notifications, for which
 * generation, and what the token does.
 */

/** The distinct blocks a delivered stream would APPLY, in order: removed entries retract. */
export function appliedBlocksOf<ABI extends Abi>(
	eventStream: readonly LogEvent<ABI>[],
): {number: number; hash: string}[] {
	const blocks: {number: number; hash: string}[] = [];
	for (const event of eventStream) {
		if (event.removed) continue;
		if (blocks[blocks.length - 1]?.number !== event.blockNumber) {
			blocks.push({number: event.blockNumber, hash: event.blockHash});
		}
	}
	return blocks;
}

/**
 * The FORK POINT a delivered stream reverts to, or `undefined` when none of it
 * is a retraction.
 *
 * One below the LOWEST removed block, computed over the whole stream before
 * anything is applied -- the same rule `applyEventStream` applies at the seam,
 * restated here because core cannot depend on the package that owns it.
 */
export function forkPointOf<ABI extends Abi>(eventStream: readonly LogEvent<ABI>[]): number | undefined {
	const retracted = eventStream.filter((event) => event.removed).map((event) => event.blockNumber);
	return retracted.length === 0 ? undefined : Math.min(...retracted) - 1;
}

/**
 * A fold that REVERTS then APPLIES and REPORTS both, which is what the entity
 * path does one package down.
 *
 * It reports from inside `process()` -- the retraction once, at the fork point,
 * BEFORE anything is applied, and then one report per block -- which is the same
 * place and the same order `applyEventStream` reports from, so the container is
 * driven exactly as the shipped fold drives it.
 */
export function reportingFold(name: string, entitiesOf: (block: number, hash: string) => string[] = () => ['thing']) {
	const applied: number[] = [];
	const retractedTo: number[] = [];
	let reporter: FoldReporter | undefined;
	/** What this fold HOLDS, per entity: the rows a reader would re-read. */
	const rows: {block: number; entity: string; row: string}[] = [];
	const processor: EventProcessor<Abi, string[]> = {
		getVersionHash: () => `proc-${name}`,
		getCodeFingerprint: () => undefined,
		load: async () => undefined,
		process: async (eventStream: LogEvent<Abi>[]) => {
			const fork = forkPointOf(eventStream);
			if (fork !== undefined) {
				// REVERT ONCE, at the fork point, before anything is applied
				for (let index = rows.length - 1; index >= 0; index--) {
					if (rows[index].block > fork) rows.splice(index, 1);
				}
				retractedTo.push(fork);
				reporter?.({kind: 'retracted', forkPoint: fork});
			}
			for (const block of appliedBlocksOf(eventStream)) {
				const entities = entitiesOf(block.number, block.hash);
				applied.push(block.number);
				for (const entity of entities) {
					rows.push({block: block.number, entity, row: `${entity}@${block.number}:${block.hash}`});
				}
				reporter?.({kind: 'applied', block: block.number, entities});
			}
			return rows.map((held) => held.row);
		},
		reset: async () => {},
		clear: async () => {},
		setFoldReporter: (next) => {
			reporter = next;
		},
	};
	return {
		processor,
		applied,
		/** The fork points this fold reverted to, in order. */
		retractedTo,
		/** What a reader re-reading THIS entity would get right now. */
		read: (entity: string) => rows.filter((held) => held.entity === entity).map((held) => held.row),
		/**
		 * EVERYTHING this fold holds, in the order it folded it: what `state` answers
		 * with while THIS generation is the canonical one.
		 *
		 * It is what makes "which generation answered" assertable at all when two of
		 * them are folding the same stream, since a read reports no identity of its
		 * own -- the same reason `promotion.test.ts`'s folds MARK what they produce.
		 */
		get rows(): string[] {
			return rows.map((held) => held.row);
		},
		/** Whether anything is listening to this fold, which is what a detach removes. */
		get attached() {
			return reporter !== undefined;
		},
	};
}

export function specFor(fold: ReturnType<typeof reportingFold>): AnyGenerationSpec<Abi, string[]> {
	return {
		createState: () => ({}),
		createProcessor: () => fold.processor,
		stateOf: () => [],
	};
}

export async function openWorld(
	folds: ReturnType<typeof reportingFold>[],
	options: {
		keepStream?: boolean;
		logs?: ReturnType<typeof makeLog>[];
		/**
		 * The promotion policy, for the cases about what a POINTER MOVE does to the
		 * token. `manual` by default (see below); naming `on-catch-up` here is how a
		 * case asserts that the move the CONTAINER makes on its own does the same
		 * thing as the one a caller asked for.
		 */
		promotion?: {policy?: PromotionPolicy; dropOnPromotion?: boolean};
	} = {},
) {
	const chain = fakeChain(options.logs ?? BRANCH_A, 105);
	const stream = memoryStream();
	const registry = await openMemoryGenerationRegistry({maxGenerations: 4, maxStreams: 2});
	const indexer = await openIndexer<Abi, string[]>({
		registry,
		provider: chain.provider,
		source: SOURCE,
		// MANUAL by default, so which generation is canonical is decided by these tests
		// and not by a successor catching up half way through one.
		promotion: options.promotion ?? {policy: 'manual'},
		config: {
			stream: {finality: FINALITY},
			...(options.keepStream ? {keepStream: stream.keeper} : {}),
			streamWriteRetry: {delaySeconds: 0},
		},
		generations: folds.map(specFor),
		createGeneration: (provider, processor, source, config) => {
			const generation = new IndexerGeneration<Abi, string[]>(provider, processor, source, config);
			(generation as unknown as {logEventFetcher: unknown}).logEventFetcher = chain.fetcher;
			return generation;
		},
	});
	const moved: StateMoved[] = [];
	const detach = indexer.onStateMoved((notification) => moved.push(notification));
	return {
		indexer,
		chain,
		stream,
		moved,
		detach,
		add: (fold: ReturnType<typeof reportingFold>) => indexer.add(specFor(fold)),
		digestOf: (name: string) =>
			generationDigestOf({
				stream: indexer.generations.find((held) => held.record.processor === `proc-${name}`)?.record.stream as string,
				processor: `proc-${name}`,
			}),
	};
}

/**
 * The notifications as APPENDS, REFUSING one that is not.
 *
 * The signal is a union since a retraction became a first-class case of it, so
 * an assertion about `block` or `entities` has to narrow. Doing it through one
 * helper keeps the failure useful -- `expected an applied-block notification,
 * got 'retracted'` names what actually arrived -- and keeps the assertion HONEST
 * where a filter would not: a retraction published by a fold that never reverts
 * is a failure here rather than something quietly skipped. Same shape, and the
 * same reason, as `streamOf` in `streamCacheWorld.ts`.
 */
export function appendsIn(moved: readonly StateMoved[]): StateApplied[] {
	return moved.map((notification) => {
		if (notification.kind !== 'applied') {
			throw new Error(`expected an applied-block notification, got '${notification.kind}'`);
		}
		return notification;
	});
}

export async function driveToTip(indexer: Indexer<Abi, string[]>, maxRounds = 20): Promise<void> {
	let rounds = 0;
	let lastSync = await indexer.indexMore();
	while (lastSync.lastToBlock < lastSync.latestBlock) {
		if (rounds++ >= maxRounds) throw new Error(`did not reach the tip in ${maxRounds} rounds`);
		lastSync = await indexer.indexMore();
	}
}
