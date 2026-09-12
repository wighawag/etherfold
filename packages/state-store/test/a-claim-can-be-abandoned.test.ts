import {describe, expect, it} from 'vitest';
import {
	MemoryStateStore,
	openForWriting,
	StoreClaimAbandonedError,
	type SeamRecordKey,
	type StateStoreBackend,
} from '../src/index.js';
import {block, owns, TOKEN} from './utils/fixtures.js';

/**
 * A CLAIM CAN HANG, SO A CALLER CAN STOP WAITING FOR IT.
 *
 * `openForWriting` claims by clearing a seam record, and that is one round trip
 * to the storage. Everything else about the claim is designed to be unwaitable --
 * no queue, no lease, no turn to take -- which made it easy to read the contract
 * as "this cannot hang". It can: on WebKit a database can be left permanently
 * unable to run ANY transaction, so the clear never settles and the call never
 * returns (`work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`).
 * An application in that state sits in `waiting` with nothing to render and
 * nothing to act on, which is exactly the outcome ADR-0082 refuses everywhere
 * else.
 *
 * So the caller may hand a signal. What is asserted here is the whole of that
 * contract, including the parts that are easy to get wrong in the direction of
 * looking fine: that abandoning does not CANCEL the claim, that it does not
 * shorten anybody else's wait, and that it leaves no unhandled rejection behind
 * when the attempt it walked away from eventually fails.
 */

/** A store whose claim never answers, which is the failure this exists for. */
class NeverAnsweringStore extends MemoryStateStore {
	cleared = 0;
	override async clearSeamRecord(_key: SeamRecordKey): Promise<void> {
		this.cleared++;
		return new Promise<void>(() => undefined);
	}
}

/** A store whose claim answers only when it is told to. */
class HeldStore extends MemoryStateStore {
	private release!: () => void;
	readonly held = new Promise<void>((resolve) => (this.release = resolve));
	override async clearSeamRecord(key: SeamRecordKey): Promise<void> {
		await this.held;
		return super.clearSeamRecord(key);
	}
	answer() {
		this.release();
	}
}

describe('a claim that can be abandoned', () => {
	it('rejects by TYPE when the signal fires, rather than hanging', async () => {
		const store = new NeverAnsweringStore([TOKEN]);
		const refused = await openForWriting(store, {signal: AbortSignal.timeout(20)}).catch((error: unknown) => error);

		expect(refused).toBeInstanceOf(StoreClaimAbandonedError);
		expect((refused as StoreClaimAbandonedError).name).toBe('StoreClaimAbandonedError');
		// RETRYABLE, unlike the seam's other two refusals: abandoning proves nothing
		// about the storage, so asking again is a legitimate thing for a caller to do.
		expect((refused as StoreClaimAbandonedError).retryable).toBe(true);
		// It says what it knows and does not claim to know who holds the store,
		// because nobody does.
		expect((refused as Error).message).toContain('abandoned before the store answered');
	});

	it('refuses an ALREADY aborted signal without waiting for a turn of the loop', async () => {
		const store = new NeverAnsweringStore([TOKEN]);
		await expect(openForWriting(store, {signal: AbortSignal.abort('gone')})).rejects.toBeInstanceOf(
			StoreClaimAbandonedError,
		);
	});

	it('carries the signal REASON, so a caller can say which bound it was', async () => {
		const store = new NeverAnsweringStore([TOKEN]);
		const refused = (await openForWriting(store, {signal: AbortSignal.abort('opening took too long')}).catch(
			(error: unknown) => error,
		)) as StoreClaimAbandonedError;
		expect(refused.reason).toBe('opening took too long');
	});

	it('does NOT cancel the claim: a second open joins the same attempt', async () => {
		const store = new NeverAnsweringStore([TOKEN]);
		await expect(openForWriting(store, {signal: AbortSignal.timeout(10)})).rejects.toBeInstanceOf(
			StoreClaimAbandonedError,
		);
		await expect(openForWriting(store, {signal: AbortSignal.timeout(10)})).rejects.toBeInstanceOf(
			StoreClaimAbandonedError,
		);
		// ONE clear, not two. The mutation was issued and may still commit, so issuing
		// another would be a second claim on a store this caller may still hold.
		expect(store.cleared).toBe(1);
	});

	it('lets a claim that lands LATE still be taken by a caller that waited', async () => {
		const store = new HeldStore([TOKEN]);
		const impatient = openForWriting(store, {signal: AbortSignal.timeout(10)}).catch((error: unknown) => error);
		const patient = openForWriting(store);

		expect(await impatient).toBeInstanceOf(StoreClaimAbandonedError);
		// One caller giving up must not shorten another's wait, which is why the
		// signal is applied per CALL and not to the shared attempt.
		store.answer();
		const writable = await patient;
		await writable.applyBlock(block(100), [owns('1', '0xalice', 1)]);
		expect(await writable.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});

	it('is unchanged when no signal is handed over', async () => {
		const store = new MemoryStateStore([TOKEN]) as StateStoreBackend;
		const writable = await openForWriting(store);
		expect(writable.token).toBeTypeOf('string');
		expect(await openForWriting(store)).toBe(writable);
	});

	it('leaves no unhandled rejection when the abandoned attempt later FAILS', async () => {
		const unhandled: unknown[] = [];
		const watch = (error: unknown) => unhandled.push(error);
		process.on('unhandledRejection', watch);
		try {
			const store = new MemoryStateStore([TOKEN]) as StateStoreBackend;
			let refuse!: (error: Error) => void;
			store.clearSeamRecord = () => new Promise<void>((_resolve, reject) => (refuse = reject));

			await expect(openForWriting(store, {signal: AbortSignal.timeout(10)})).rejects.toBeInstanceOf(
				StoreClaimAbandonedError,
			);
			refuse(new Error('the storage gave up too'));
			// two macrotask turns, which is where an unhandled rejection would surface
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', watch);
		}
	});
});
