import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {openForReading, openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	IndexerHostDiedError,
	serveIndexerHost,
	type HostAccess,
	type HostDeath,
	type HostProgress,
	type IndexerHost,
	type IndexerPort,
	type MessageEndpoint,
} from '../src/index.js';
import {
	ALICE,
	BRANCH_A_TIP,
	EXPECTED_A,
	FINALITY,
	fakeChain,
	processor,
	readState,
	SOURCE,
	START_BLOCK,
	txInBlock,
	type FetchedRange,
	type TestABI,
} from '../browser/workload.js';

/**
 * A HOST THAT STOPPED EXISTING, AND THE TAB THAT NOTICED -- over a real
 * `MessagePort`, in node.
 *
 * Browsers evict workers, so a death is an EXPECTED event with a defined outcome
 * (ADR-0082): the app is told, every call in flight rejects by TYPE, the port
 * restarts the host, and the fold RESUMES from the cursor because the cursor was
 * written in the same transaction as the block it describes (ADR-0027).
 *
 * What runs in a real browser, with a real dedicated worker really terminated
 * mid-fold, is `browser/restartsAndResumes.spec.ts`. That is where the kill is a
 * `Worker.terminate()` rather than a host asked to stop answering, and it is the
 * case the acceptance criteria name. These are the same claims on every commit,
 * because that run needs browser binaries a clean checkout does not have.
 *
 * ## How a host is KILLED here
 *
 * `IndexerHost.dispose()` and then nothing: the host stops answering its
 * endpoint, exactly as a terminated worker does, and NOBODY TELLS THE PORT. That
 * is the whole point -- no browser fires an event when it evicts a dedicated
 * worker, so what the tab actually has to work from is silence, and a test that
 * told the port would be testing a mechanism no browser offers.
 */

let counter = 0;
const freshName = () => `restarting-host-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * THE CHAIN THE FIRST HOST CANNOT GET PAST.
 *
 * A fold has to be HELD somewhere known for there to be a middle of one to die
 * in: this fixture's five blocks arrive in two fetches, and a chain that answers
 * instantly finishes both between two polls. So the first host's provider parks
 * on the fetch that would take it above `block` and never comes back -- which is
 * also the more honest kill, because what dies is a host with a chain request in
 * flight rather than one resting between cycles.
 *
 * Only the FIRST host is held: what is being asked of the successor is where IT
 * resumes from.
 */
function heldAbove(chain: ReturnType<typeof fakeChain>, block: number): typeof chain.provider {
	const underlying = chain.provider as unknown as {request(args: unknown): Promise<unknown>};
	return {
		async request(args: {method: string; params?: unknown}): Promise<unknown> {
			if (args.method === 'eth_getLogs') {
				const asked = args.params as [{toBlock: string}];
				// A promise nobody resolves: this host is never getting past here, which is
				// what an evicted worker looks like from the store's side.
				if (parseInt(asked[0].toBlock.slice(2), 16) > block) await new Promise(() => undefined);
			}
			return underlying.request(args);
		},
	} as unknown as typeof chain.provider;
}

/**
 * A HOSTING SHAPE THE PORT CAN RE-OBTAIN, and a way to kill what it obtained.
 *
 * It is the `main-thread` shape named honestly -- a `MessageChannel` is the same
 * structured-clone boundary a worker is, and what it has no way to have is a
 * second execution context. `reopen` is the whole of what a restart needs from a
 * shape, and this one builds a fresh host over a fresh channel, which is what a
 * `new Worker(...)` is on the other side of this seam.
 *
 * `order` records what the port DID to the shape, in sequence, because "two hosts
 * never write to one store" is a claim about ordering: the corpse is closed
 * BEFORE a successor is opened, never after.
 */
function restartableHost(
	databaseName: string,
	chain: ReturnType<typeof fakeChain>,
	/** Where the FIRST host's fold is held, so that there is a middle of one to die in. */
	heldAboveBlock: number | undefined = undefined,
	/**
	 * The fixture's five blocks in more than one piece, and WIDER THAN `FINALITY`: a
	 * range narrower than the unconfirmed window re-asks for the blocks it already
	 * has and the cursor never moves at all.
	 */
	fetchWidth = 4,
): {
	access: HostAccess;
	hosts: IndexerHost[];
	order: ('open' | 'close')[];
	kill: () => void;
	disposeAll: () => void;
} {
	const hosts: IndexerHost[] = [];
	const order: ('open' | 'close')[] = [];
	const channels: MessageChannel[] = [];

	const open = (): HostAccess => {
		const channel = new MessageChannel();
		channels.push(channel);
		const first = hosts.length === 0;
		order.push('open');
		const host = serveIndexerHost<TestABI, EntityStateView>(
			{
				// THE HOST IS THE WRITER, in every life: the claim is taken here, and a
				// successor takes it from a corpse that is no longer writing (ADR-0075).
				createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
				createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
				provider: first && heldAboveBlock !== undefined ? heldAbove(chain, heldAboveBlock) : chain.provider,
				source: SOURCE,
				config: {
					stream: {finality: FINALITY},
					fetch: {numBlocksToFetchAtStart: fetchWidth, maxBlocksPerFetch: fetchWidth},
				},
				tipIntervalInSeconds: 0.05,
			},
			{host: 'main-thread', endpoint: channel.port1 as unknown as MessageEndpoint},
		);
		hosts.push(host);
		return {
			host: 'main-thread',
			endpoint: channel.port2 as unknown as MessageEndpoint,
			close: () => {
				order.push('close');
				host.dispose();
				channel.port1.close();
			},
			reopen: open,
		};
	};

	return {
		access: open(),
		hosts,
		order,
		kill: () => hosts[hosts.length - 1]?.dispose(),
		disposeAll: () => {
			for (const host of hosts) host.dispose();
			for (const channel of channels) {
				channel.port1.close();
				channel.port2.close();
			}
		},
	};
}

/** A shape whose hosts never answer at all: what a worker that dies on boot looks like. */
function stillbornHost(): {access: HostAccess; opened: () => number} {
	let opened = 0;
	const open = (): HostAccess => {
		opened++;
		const channel = new MessageChannel();
		return {
			host: 'main-thread',
			endpoint: channel.port2 as unknown as MessageEndpoint,
			close: () => {
				channel.port1.close();
				channel.port2.close();
			},
			reopen: open,
		};
	};
	return {access: open(), opened: () => opened};
}

/** Watch and restart fast, so a case waits on a VALUE and never on a duration. */
const IMPATIENT = {
	watch: {everyInSeconds: 0.05},
	restart: {backoffInSeconds: 0.01, maxBackoffInSeconds: 0.02},
} as const;

async function until(port: IndexerPort, matches: (progress: HostProgress) => boolean, attempts = 400) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const progress = await port.progress().catch(() => undefined);
		if (progress && matches(progress)) return progress;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`the host never got there: ${JSON.stringify(await port.progress().catch((error) => `${error}`))}`);
}

const untilAtTip = (port: IndexerPort) =>
	until(port, (progress) => progress.latestBlock === BRANCH_A_TIP && progress.lastToBlock === progress.latestBlock);

/** The state the host wrote, read back the way a tab reads it: through a READER. */
async function stateFrom(databaseName: string) {
	const reader = openForReading(await createBrowserStateStore(processor.entities, {databaseName}));
	return readState(new EntityStateView(reader));
}

/**
 * WHETHER THESE RANGES COVER THE SPAN WITH NO HOLE IN IT.
 *
 * The honest form of "no skipped range", and the reason it is a sweep rather than
 * a comparison of two numbers: a resume RE-asks for part of what it already had
 * (the unconfirmed window is refetched by design), so the ranges overlap, and
 * what must be true is that their union has no gap -- not that one begins exactly
 * where another ended.
 */
function coversWithoutGaps(ranges: readonly FetchedRange[], from: number, to: number): boolean {
	let reached = from - 1;
	for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
		if (range.from > reached + 1) return false;
		reached = Math.max(reached, range.to);
	}
	return reached >= to;
}

describe('a host that died, and the tab that restarts it', () => {
	it('tells the tab, and rejects the call that was in flight, with a typed refusal', async () => {
		const lives = restartableHost(freshName(), fakeChain());
		const port = connectToIndexerHost(lives.access, IMPATIENT);

		try {
			const deaths: HostDeath[] = [];
			port.onHostDeath((death) => deaths.push(death));

			// A call the host will never answer, because it stops existing in the same
			// turn the question was posted.
			const inFlight = port.progress();
			lives.kill();

			// REJECTED, and recognisable by TYPE rather than by reading a sentence: an
			// app has to be able to tell "the host died under this call" apart from
			// "this call was refused for a reason of its own" (ADR-0082). A hung promise
			// is the worst available outcome, because a stalled app and a slow app look
			// identical from outside.
			await expect(inFlight).rejects.toThrow(IndexerHostDiedError);
			await expect(inFlight).rejects.toMatchObject({name: 'IndexerHostDiedError', case: 'progress'});

			// AND IT WAS AN EVENT: the app was told, rather than left to infer a death
			// from a number that stopped moving.
			expect(deaths).toHaveLength(1);
			expect(deaths[0]).toMatchObject({cause: 'unresponsive', attempt: 1, restarting: true, rejected: 1});
		} finally {
			port.close();
			lives.disposeAll();
		}
	});

	it('resumes from the cursor: nothing is re-indexed from the start block and no range is skipped', async () => {
		const databaseName = freshName();
		const chain = fakeChain();
		const lives = restartableHost(databaseName, chain, 103);
		const port = connectToIndexerHost(lives.access, IMPATIENT);

		try {
			// MID-FOLD: blocks have been applied and the tip has not been reached, so
			// there is a cursor to resume FROM and work left to resume TO.
			await until(port, (progress) => (progress.lastToBlock ?? 0) >= 103 && progress.lastToBlock !== BRANCH_A_TIP);
			const beforeDeath = chain.ranges.length;
			lives.kill();

			const resumed = await untilAtTip(port);
			const refetched = chain.ranges.slice(beforeDeath);

			// THE TRAP THIS CASE EXISTS FOR: a restart that re-runs the LOAD looks
			// correct on a five-block fixture and costs an afternoon on a real one. So
			// the claim is about what was asked of the node, not only about where the
			// fold ended up.
			expect(refetched.length).toBeGreaterThan(0);
			expect(Math.min(...refetched.map((range) => range.from))).toBeGreaterThan(START_BLOCK);

			// ...and nothing was jumped over on the way, which is the other half of the
			// same claim and the one a cursor written AHEAD of its data would break.
			expect(coversWithoutGaps(chain.ranges, START_BLOCK, BRANCH_A_TIP)).toBe(true);

			// The state is the state an UNINTERRUPTED run of this workload produces.
			expect(resumed.lastToBlock).toBe(BRANCH_A_TIP);
			expect(await stateFrom(databaseName)).toEqual(EXPECTED_A);

			// TWO HOSTS NEVER WROTE AT ONCE: the corpse was closed before its successor
			// was opened, which is an ordering rather than a hope.
			expect(lives.order).toEqual(['open', 'close', 'open']);
			expect(lives.hosts).toHaveLength(2);
		} finally {
			port.close();
			lives.disposeAll();
		}
	});

	it('answers every surface it answered before, once the host is back', async () => {
		const databaseName = freshName();
		const lives = restartableHost(databaseName, fakeChain(), 103);
		const port = connectToIndexerHost(lives.access, IMPATIENT);

		try {
			const pushes: HostProgress[] = [];
			// Subscribed BEFORE the death, and never re-subscribed by this test: a tab
			// that had to re-attach after every restart would be holding the lifecycle
			// the port exists to hide.
			port.onProgress((progress) => pushes.push(progress));

			await until(port, (progress) => (progress.lastToBlock ?? 0) >= 103 && progress.lastToBlock !== BRANCH_A_TIP);
			const pushedBeforeDeath = pushes.length;
			lives.kill();

			await untilAtTip(port);

			expect((await port.progress()).lastToBlock).toBe(BRANCH_A_TIP);
			expect(await port.generations()).toHaveLength(1);
			expect((await port.promotion()).policy).toBeDefined();
			expect((await port.checkTxInclusion([{txHash: txInBlock(104)}]))[txInBlock(104)].status).toBe('included');
			expect((await port.reads.getCurrent('counter', {name: 'transfers'})) as {value: number}).toMatchObject({
				value: EXPECTED_A.transfers,
			});
			expect((await port.reads.listCurrent('token', {id: '1'}, 10)).rows).toHaveLength(1);
			expect(await port.reads.getAsOf('token', {id: '1'}, 100)).toMatchObject({owner: ALICE});
			expect((await port.reads.listAsOf('token', {id: '1'}, 100, 10)).rows).toHaveLength(1);
			expect(await port.reads.declarations()).toHaveLength(2);
			// The same source names the generation that is already running, so this
			// exercises the case without rebuilding anything.
			expect(await port.reconfigure({source: SOURCE})).toMatchObject({added: false});
			expect((await port.stopIndexing()).indexing).toBe(false);
			expect((await port.startIndexing()).indexing).toBe(true);

			// The PUSH survived too, which nothing else on this list would have proved:
			// the subscription belongs to the tab, and the port re-opens it against the
			// host it started.
			expect(pushes.length).toBeGreaterThan(pushedBeforeDeath);
			expect(pushes[pushes.length - 1].lastToBlock).toBe(BRANCH_A_TIP);
		} finally {
			port.close();
			lives.disposeAll();
		}
	});

	it('stops restarting a host that only ever dies, and says that is what happened', async () => {
		const stillborn = stillbornHost();
		const port = connectToIndexerHost(stillborn.access, {
			watch: {everyInSeconds: 0.05},
			restart: {attempts: 2, backoffInSeconds: 0.01, maxBackoffInSeconds: 0.02},
		});

		try {
			const deaths: HostDeath[] = [];
			const abandoned = new Promise<HostDeath>((resolve) => {
				port.onHostDeath((death) => {
					deaths.push(death);
					if (!death.restarting) resolve(death);
				});
			});

			const last = await abandoned;

			// A BOUNDED loop, and an app that can SEE it is happening: the attempt
			// counter is on every death, and the last one says nobody is coming.
			expect(last).toMatchObject({attempt: 3, restarting: false});
			expect(deaths.map((death) => death.restarting)).toEqual([true, true, false]);
			expect(stillborn.opened()).toBe(3);

			// ...and the port stays refusing rather than hanging, which is the same rule
			// one step later: a call to a host nobody is restarting is answered NOW.
			await expect(port.progress()).rejects.toThrow(IndexerHostDiedError);

			// Nothing further is tried: the budget is spent, not merely slowed down.
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(stillborn.opened()).toBe(3);
			expect(deaths).toHaveLength(3);
		} finally {
			port.close();
		}
	});

	it('does not watch, restart or report anything once the TAB let the host go', async () => {
		const lives = restartableHost(freshName(), fakeChain());
		const port = connectToIndexerHost(lives.access, IMPATIENT);
		const deaths: HostDeath[] = [];
		port.onHostDeath((death) => deaths.push(death));

		try {
			await until(port, (progress) => (progress.lastToBlock ?? 0) > 0);
			port.close();
			await new Promise((resolve) => setTimeout(resolve, 200));

			// A CLOSE IS NOT A DEATH. The tab asked for this one, so there is nobody to
			// tell and nothing to restart -- and a port that restarted here would build
			// hosts for an app that has gone.
			expect(deaths).toEqual([]);
			expect(lives.hosts).toHaveLength(1);
			await expect(port.progress()).rejects.toThrow(/this indexer port is closed/);
		} finally {
			lives.disposeAll();
		}
	});
});
