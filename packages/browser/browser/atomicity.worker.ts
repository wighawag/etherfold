/**
 * A WORKER THAT DOES NOTHING BUT APPLY BLOCKS, so a kill can be aimed at the
 * transaction itself.
 *
 * `indexer.worker.ts` runs the whole hosted indexer, which is what the restart
 * case needs and what makes it a poor instrument for this question: between the
 * chain, the container and the port there is very little of any second in which
 * the store's own `readwrite` transaction is actually open. Here the fold is
 * removed and only the write is left, so `Worker.terminate()` lands inside
 * `applyBlock` most of the time rather than occasionally.
 *
 * ## What is being asked
 *
 * Whether a block applies WHOLE OR NOT AT ALL when the worker dies in the middle
 * of applying it. That is the seam's own promise -- "one block is one
 * transaction", with the sync cursor written inside it (ADR-0027) -- and until
 * now nothing asserted it on any engine. The reason to assert it is WebKit bug
 * 288682, where a terminated worker's half-finished IndexedDB transaction was
 * COMMITTED rather than aborted, which is exactly this shape: every request here
 * is awaited through a promise, and that is the case the bug turned on. It is
 * fixed upstream, and the point of a test is that we stop having to take that on
 * trust across the engines and versions an application actually meets.
 *
 * Each block writes rows that belong to NO OTHER BLOCK (`b<n>-<i>`), so "did
 * block n land" is answerable per block rather than by inspecting the latest
 * value of a shared row. A partial commit is therefore visible three different
 * ways -- the block record, the cursor and the rows can disagree -- and the page
 * checks all three (`cut.ts`, the `block-atomicity` case).
 */
import {openForWriting} from '@etherfold/state-store';
import {createBrowserStateStore} from '../src/index.js';
import {processor} from './workload.js';

const url = new URL(self.location.href);
const databaseName = url.searchParams.get('db') ?? 'etherfold-atomicity';
/** How many rows each block writes. More rows is a wider window to be killed inside. */
const ROWS_PER_BLOCK = Number(url.searchParams.get('rows') ?? '24');
/** The first block this worker applies. Blocks below it were never offered. */
export const FIRST_BLOCK = 100;

const say = (message: Record<string, unknown>) => self.postMessage({fixture: 'atomicity', ...message});

/** The rows block `n` writes, and nothing else writes. */
export function rowsOfBlock(n: number, rows = ROWS_PER_BLOCK): {id: string; owner: string}[] {
	return Array.from({length: rows}, (_unused, index) => ({
		id: `b${n}-${index}`,
		owner: `0x${n.toString(16).padStart(8, '0')}${index}`,
	}));
}

async function main(): Promise<void> {
	const store = await openForWriting(await createBrowserStateStore(processor.entities, {databaseName}));
	say({ready: true});

	for (let block = FIRST_BLOCK; ; block++) {
		// ANNOUNCED BEFORE the transaction opens, which is what lets the page aim its
		// kill at the write rather than at the gap between two of them.
		say({wrote: 'starting', block});
		await store.applyBlock(
			{number: block, hash: `0x${block.toString(16).padStart(64, '0')}`, timestamp: block},
			rowsOfBlock(block).map((row) => ({
				type: 'upsert' as const,
				entity: 'token',
				id: {id: row.id},
				values: {owner: row.owner},
			})),
			// The cursor rides in the SAME transaction as the block it describes, which
			// is the half of the promise a partial commit would break most visibly: a
			// cursor ahead of its data is a fold that silently skips.
			{key: 'lastSync', value: JSON.stringify({lastToBlock: block})},
		);
		say({wrote: 'landed', block});
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

void main().catch((error: unknown) => say({failed: `${(error as Error)?.name}: ${(error as Error)?.message}`}));
