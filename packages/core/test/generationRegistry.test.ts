import {describe, expect, it} from 'vitest';
import {
	GenerationCapReachedError,
	GenerationIsCanonicalError,
	openGenerationRegistry,
	UnknownGenerationError,
	UnknownStreamError,
	writerOf,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistryPort,
	type GenerationRegistryState,
} from '../src/generation/registry.js';

// ---------------------------------------------------------------------------
// THE GENERATION REGISTRY, against a memory port. NO INDEXER RUNS HERE.
// ---------------------------------------------------------------------------
// This is the substrate-neutral half: the identity of a generation, the one
// canonical pointer, the two caps that REFUSE, deletion with the stream reaped
// when its last generation goes, and the sweep of subtrees the registry does not
// know about. The IndexedDB keeper's own concerns (the array address, the key
// ranges, the one `readwrite` transaction, a real state store being dropped) are
// asserted in `@etherfold/browser`, against `fake-indexeddb`.
//
// Nothing in this file fetches, indexes or folds anything, and the port has no
// operation with which it could: the registry is BOOKKEEPING, and a bookkeeping
// mistake here is what silently costs a re-index later.

const PROC_A = 'processor-a';
const PROC_B = 'processor-b';
const STREAM_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STREAM_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const STREAM_C = 'cccccccccccccccccccccccccccccccc';

const CAPS = {maxGenerations: 8, maxStreams: 4};

type Call = {op: string; detail?: unknown};

/**
 * A port over three collections, plus a log of every operation.
 *
 * `commit` applies the registry's plan to the state it was handed IN THE SAME
 * STEP, which is what an IndexedDB `readwrite` transaction and a SQL transaction
 * both give it for free -- and what makes the cap check honest when two tabs
 * create at once.
 *
 * `streams` is the SUBSTRATE's set of stream subtrees, deliberately separate
 * from the registry's records: the whole point of the sweep is that the two can
 * disagree, and a port that derived one from the other could not express the
 * case it exists for.
 */
function memoryPort() {
	const generations = new Map<string, GenerationRecord>();
	let canonical: GenerationId | undefined;
	const streams = new Set<string>();
	const states = new Set<string>();
	const calls: Call[] = [];
	const keyOf = (id: GenerationId) => `${id.stream}\u0000${id.processor}`;

	const snapshot = (): GenerationRegistryState => ({generations: [...generations.values()], canonical});

	const port: GenerationRegistryPort = {
		async read() {
			calls.push({op: 'read'});
			return snapshot();
		},
		async commit(plan) {
			const write = plan(snapshot());
			calls.push({op: 'commit', detail: write});
			if (!write) return;
			for (const id of write.remove ?? []) {
				generations.delete(keyOf(id));
			}
			if (write.put) {
				generations.set(keyOf(write.put), write.put);
			}
			if (write.canonical) {
				canonical = {stream: write.canonical.stream, processor: write.canonical.processor};
			}
		},
		async listStreamDigests() {
			calls.push({op: 'listStreamDigests'});
			return [...streams].sort();
		},
		async dropStreamSubtree(digest) {
			calls.push({op: 'dropStreamSubtree', detail: digest});
			return streams.delete(digest) ? 1 : 0;
		},
		async dropState(id) {
			calls.push({op: 'dropState', detail: id});
			states.delete(keyOf(id));
		},
	};

	return {
		port,
		calls,
		streams,
		/** What an indexer WRITING this stream leaves on the substrate. */
		writeStreamSubtree(...digests: string[]) {
			for (const digest of digests) {
				streams.add(digest);
			}
		},
		/** The state store a generation folded into, as a fact the port can drop. */
		writeState(id: GenerationId) {
			states.add(keyOf(id));
		},
		hasState(id: GenerationId) {
			return states.has(keyOf(id));
		},
	};
}

const idOf = (stream: string, processor: string): GenerationId => ({stream, processor});

describe('a generation is created and registered', () => {
	it('is identified by its stream digest plus the processor version hash', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);

		const created = await registry.create(idOf(STREAM_A, PROC_A));

		expect(created.stream).toBe(STREAM_A);
		expect(created.processor).toBe(PROC_A);
		expect(await registry.list()).toHaveLength(1);
		// the same stream folded by another processor is ANOTHER generation, and the
		// same processor over another stream is too: both halves are the identity
		await registry.create(idOf(STREAM_A, PROC_B));
		await registry.create(idOf(STREAM_B, PROC_A));
		expect(await registry.list()).toHaveLength(3);
		expect(await registry.streams()).toEqual([STREAM_A, STREAM_B]);
	});

	it('RESOLVES an identity that is already registered instead of registering a second one', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);

		const first = await registry.create(idOf(STREAM_A, PROC_A));
		const again = await registry.create(idOf(STREAM_A, PROC_A));

		expect(again).toEqual(first);
		expect(await registry.list()).toHaveLength(1);
	});

	it('takes its starting stream as an INPUT, so a second generation over it fetches nothing', async () => {
		// the stream is on the substrate already -- backfilled by an earlier
		// generation, or seeded from a published artifact. Creation NAMES it.
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		await registry.create(idOf(STREAM_A, PROC_A));
		world.writeStreamSubtree(STREAM_A);
		world.calls.length = 0;

		await registry.create(idOf(STREAM_A, PROC_B));

		// nothing is re-fetched because there is nothing here that COULD fetch, and
		// the stream is left exactly as it was
		expect(world.streams.has(STREAM_A)).toBe(true);
		expect(world.calls.map((call) => call.op)).not.toContain('dropStreamSubtree');
		expect(await registry.streams()).toEqual([STREAM_A]);
	});

	it('refuses an identity with an empty half, rather than registering one nothing can name', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);

		await expect(registry.create(idOf('', PROC_A))).rejects.toThrow(TypeError);
		await expect(registry.create(idOf(STREAM_A, ''))).rejects.toThrow(TypeError);
		expect(await registry.list()).toHaveLength(0);
	});
});

describe('one canonical pointer names the generation that answers reads', () => {
	it('takes the FIRST generation, because a registry that points at nothing answers nothing', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);

		expect(await registry.canonical()).toBeUndefined();
		const first = await registry.create(idOf(STREAM_A, PROC_A));

		expect(await registry.canonical()).toEqual(first);
	});

	it('does NOT move to a successor on its own: that is the promotion policy, not the pointer', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		const first = await registry.create(idOf(STREAM_A, PROC_A));

		await registry.create(idOf(STREAM_A, PROC_B));

		expect(await registry.canonical()).toEqual(first);
	});

	it('moves in ONE small record write, and back again', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		const blue = await registry.create(idOf(STREAM_A, PROC_A));
		const green = await registry.create(idOf(STREAM_A, PROC_B));
		world.calls.length = 0;

		await registry.moveCanonicalTo(green);
		expect(await registry.canonical()).toEqual(green);

		// ONE write, and it carries no generation record with it: promotion is a
		// pointer move and nothing else, which is why it has no meaningful cost
		const writes = world.calls.filter((call) => call.op === 'commit');
		expect(writes).toHaveLength(1);
		expect(writes[0].detail).toEqual({canonical: {stream: green.stream, processor: green.processor}});

		await registry.moveCanonicalTo(blue);
		expect(await registry.canonical()).toEqual(blue);
	});

	it('restores the previous generation EXACTLY when it moves back, with nothing re-indexed', async () => {
		// each generation's answers, as the state store it folded into. The registry
		// names WHICH one answers; the stores themselves are untouched by a move.
		const world = memoryPort();
		const answers = new Map<string, number>([
			[PROC_A, 41],
			[PROC_B, 7],
		]);
		const registry = await openGenerationRegistry(world.port, CAPS);
		const blue = await registry.create(idOf(STREAM_A, PROC_A));
		const green = await registry.create(idOf(STREAM_A, PROC_B));
		const read = async () => answers.get((await registry.canonical())!.processor);

		expect(await read()).toBe(41);
		await registry.moveCanonicalTo(green);
		expect(await read()).toBe(7);
		await registry.moveCanonicalTo(blue);

		expect(await read()).toBe(41);
		// a revert is a pointer move, so there is nothing to rebuild and nothing to
		// fetch, and no state was dropped on the way
		expect(await registry.canonical()).toEqual(blue);
		expect(world.calls.map((call) => call.op)).not.toContain('dropState');
	});

	it('refuses to point at a generation that is not registered', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		await registry.create(idOf(STREAM_A, PROC_A));

		await expect(registry.moveCanonicalTo(idOf(STREAM_B, PROC_A))).rejects.toThrow(UnknownGenerationError);
		expect((await registry.canonical())?.processor).toBe(PROC_A);
	});
});

describe('a cap REFUSES and names what to delete', () => {
	it('refuses the new generation at maxGenerations, evicting nothing', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, {maxGenerations: 2, maxStreams: 4});
		const first = await registry.create(idOf(STREAM_A, PROC_A));
		const second = await registry.create(idOf(STREAM_A, PROC_B));

		const refusal = (await registry.create(idOf(STREAM_B, PROC_A)).catch((error: unknown) => error)) as
			| GenerationCapReachedError
			| undefined;

		expect(refusal).toBeInstanceOf(GenerationCapReachedError);
		expect(refusal?.cap).toBe('maxGenerations');
		expect(refusal?.limit).toBe(2);
		// it NAMES what to delete, and names ALL of it: choosing a victim is what a
		// policy cannot do, because it cannot know which one was being kept
		expect(refusal?.candidates).toEqual([{stream: second.stream, processor: second.processor}]);
		expect(refusal?.message).toContain(PROC_B);

		// nothing was evicted, and every existing generation is still there
		expect(await registry.list()).toEqual([first, second]);
		expect(await registry.canonical()).toEqual(first);
		expect(world.calls.map((call) => call.op)).not.toContain('dropState');
	});

	it('refuses at maxStreams even where maxGenerations has room', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, {maxGenerations: 8, maxStreams: 2});
		await registry.create(idOf(STREAM_A, PROC_A));
		await registry.create(idOf(STREAM_B, PROC_A));

		const refusal = (await registry.create(idOf(STREAM_C, PROC_A)).catch((error: unknown) => error)) as
			| GenerationCapReachedError
			| undefined;

		expect(refusal).toBeInstanceOf(GenerationCapReachedError);
		expect(refusal?.cap).toBe('maxStreams');
		expect(refusal?.candidateStreams).toEqual([STREAM_B]);
		// nothing was evicted here either: both generations are still registered and
		// both streams are still theirs
		expect(await registry.list()).toHaveLength(2);
		expect(await registry.streams()).toEqual([STREAM_A, STREAM_B]);
		expect(world.calls.map((call) => call.op)).not.toContain('dropState');
		expect(world.calls.map((call) => call.op)).not.toContain('dropStreamSubtree');
		// another generation on a stream already held is still accepted: this cap is
		// on the streams, and that one adds none
		await registry.create(idOf(STREAM_B, PROC_B));
		expect(await registry.list()).toHaveLength(3);
	});

	it('holds maxGenerations as a TOTAL, so adding streams does not raise the ceiling', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, {maxGenerations: 3, maxStreams: 8});
		await registry.create(idOf(STREAM_A, PROC_A));
		await registry.create(idOf(STREAM_B, PROC_A));
		await registry.create(idOf(STREAM_C, PROC_A));

		// three streams, one generation each, and the FOURTH is refused: a per-stream
		// cap would let total storage grow with the stream count, which is the
		// resource anyone actually cares about
		await expect(registry.create(idOf(STREAM_B, PROC_B))).rejects.toThrow(GenerationCapReachedError);
		expect(await registry.list()).toHaveLength(3);
	});

	it('does not refuse a generation that is already registered, however full it is', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, {maxGenerations: 1, maxStreams: 1});
		const only = await registry.create(idOf(STREAM_A, PROC_A));

		// re-resolving what is already there adds nothing, so there is nothing to
		// refuse -- and a boot that resolves its own generation would otherwise be
		// refused at a cap of one
		expect(await registry.create(idOf(STREAM_A, PROC_A))).toEqual(only);
	});

	it('refuses a cap that is not a whole number of at least one', async () => {
		const world = memoryPort();

		await expect(openGenerationRegistry(world.port, {maxGenerations: 0, maxStreams: 1})).rejects.toThrow(TypeError);
		await expect(openGenerationRegistry(world.port, {maxGenerations: 2, maxStreams: 1.5})).rejects.toThrow(TypeError);
	});
});

describe('deleting a generation, and reaping the stream when its last one goes', () => {
	it('drops the state store and LEAVES the stream another generation is using', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		const blue = await registry.create(idOf(STREAM_A, PROC_A));
		const green = await registry.create(idOf(STREAM_A, PROC_B));
		world.writeStreamSubtree(STREAM_A);
		world.writeState(blue);
		world.writeState(green);

		const report = await registry.deleteGeneration(green);

		expect(report.generation).toEqual(green);
		expect(report.reaped).toBeUndefined();
		expect(world.hasState(green)).toBe(false);
		// the other generation, and the stream it folds, are untouched
		expect(world.hasState(blue)).toBe(true);
		expect(world.streams.has(STREAM_A)).toBe(true);
		expect(await registry.list()).toEqual([blue]);
	});

	it('reaps the stream when the LAST generation on it goes', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		await registry.create(idOf(STREAM_A, PROC_A));
		const onB = await registry.create(idOf(STREAM_B, PROC_A));
		world.writeStreamSubtree(STREAM_A, STREAM_B);

		const report = await registry.deleteGeneration(onB);

		expect(report.reaped).toBe(STREAM_B);
		expect(world.streams.has(STREAM_B)).toBe(false);
		expect(world.streams.has(STREAM_A)).toBe(true);
		expect(await registry.streams()).toEqual([STREAM_A]);
	});

	it('removes the RECORD before the bytes, so a crash leaks rather than lies', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		await registry.create(idOf(STREAM_A, PROC_A));
		const onB = await registry.create(idOf(STREAM_B, PROC_A));
		world.writeStreamSubtree(STREAM_B);
		world.calls.length = 0;

		await registry.deleteGeneration(onB);

		// a registry that still claimed a generation whose state had gone would
		// answer from nothing; an orphan subtree is collected by the sweep on the
		// next open, which is exactly the recovery this ordering relies on
		expect(world.calls.map((call) => call.op)).toEqual(['commit', 'dropState', 'dropStreamSubtree']);
	});

	it('refuses to delete the CANONICAL generation, and says to move the pointer first', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		const blue = await registry.create(idOf(STREAM_A, PROC_A));
		world.writeStreamSubtree(STREAM_A);

		const refusal = (await registry.deleteGeneration(blue).catch((error: unknown) => error)) as Error;
		expect(refusal).toBeInstanceOf(GenerationIsCanonicalError);
		expect(refusal.message).toContain('canonical');
		expect(await registry.list()).toEqual([blue]);
		expect(world.streams.has(STREAM_A)).toBe(true);
	});

	it('refuses a generation it does not hold, rather than reporting a silent success', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		await registry.create(idOf(STREAM_A, PROC_A));

		await expect(registry.deleteGeneration(idOf(STREAM_A, PROC_B))).rejects.toThrow(UnknownGenerationError);
	});
});

describe('the WRITER of a stream is the oldest surviving generation on it', () => {
	/**
	 * ADR-0044 says the writer is the FIRST generation held on a stream and never
	 * the canonical one. What happens when THAT generation is deleted is
	 * ADR-0044's amendment: the duty passes to the next oldest, and it passes in
	 * the same commit as the delete because nothing stores it.
	 */
	it('is the oldest, and is deliberately not the canonical one', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		const original = await registry.create(idOf(STREAM_A, PROC_A));
		const successor = await registry.create(idOf(STREAM_A, PROC_B));
		await registry.moveCanonicalTo(successor);

		expect(await registry.writerOf(STREAM_A)).toEqual(original);
	});

	it('succeeds to the next oldest when the writer is deleted, with nothing written for it', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		const original = await registry.create(idOf(STREAM_A, PROC_A));
		const successor = await registry.create(idOf(STREAM_A, PROC_B));
		await registry.moveCanonicalTo(successor);
		world.calls.length = 0;

		await registry.deleteGeneration(original);

		expect(await registry.writerOf(STREAM_A)).toEqual(successor);
		// ONE commit: succession is atomic with the drop because it is stored
		// nowhere, so there is no second write for a crash to land between
		expect(world.calls.filter((call) => call.op === 'commit')).toHaveLength(1);
	});

	it('has nobody to hand the duty to when the last generation goes, which is why the stream is reaped', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		await registry.create(idOf(STREAM_A, PROC_A));
		const alone = await registry.create(idOf(STREAM_B, PROC_A));
		world.writeStreamSubtree(STREAM_A, STREAM_B);

		await registry.deleteGeneration(alone);

		expect(await registry.writerOf(STREAM_B)).toBeUndefined();
		expect(world.streams.has(STREAM_B)).toBe(false);
	});

	it('reads the answer from the records alone, oldest first and ties broken on the identity', () => {
		const records = [
			{stream: STREAM_A, processor: PROC_B, createdAt: 2_000},
			{stream: STREAM_A, processor: PROC_A, createdAt: 1_000},
			{stream: STREAM_B, processor: PROC_A, createdAt: 500},
		];

		expect(writerOf(records, STREAM_A)).toEqual(records[1]);
		expect(writerOf(records, STREAM_B)).toEqual(records[2]);
		expect(writerOf(records, STREAM_C)).toBeUndefined();
	});
});

describe('deleting a stream', () => {
	it('takes every generation on it and its keyspace, in one call', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		const keep = await registry.create(idOf(STREAM_A, PROC_A));
		const onB1 = await registry.create(idOf(STREAM_B, PROC_A));
		const onB2 = await registry.create(idOf(STREAM_B, PROC_B));
		world.writeStreamSubtree(STREAM_A, STREAM_B);
		world.writeState(onB1);
		world.writeState(onB2);

		const report = await registry.deleteStream(STREAM_B);

		expect(report.generations).toEqual([onB1, onB2]);
		expect(world.hasState(onB1)).toBe(false);
		expect(world.hasState(onB2)).toBe(false);
		expect(world.streams.has(STREAM_B)).toBe(false);
		expect(await registry.list()).toEqual([keep]);
		expect(world.streams.has(STREAM_A)).toBe(true);
	});

	it('refuses the stream the canonical generation folds, and a digest it does not hold', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);
		await registry.create(idOf(STREAM_A, PROC_A));
		world.writeStreamSubtree(STREAM_A);

		await expect(registry.deleteStream(STREAM_A)).rejects.toThrow(GenerationIsCanonicalError);
		await expect(registry.deleteStream(STREAM_C)).rejects.toThrow(UnknownStreamError);
		expect(world.streams.has(STREAM_A)).toBe(true);
	});
});

describe('the unregistered-subtree sweep', () => {
	it('drops a subtree no generation claims, ON OPEN, and reports what went', async () => {
		const world = memoryPort();
		const first = await openGenerationRegistry(world.port, CAPS);
		await first.create(idOf(STREAM_A, PROC_A));
		world.writeStreamSubtree(STREAM_A, STREAM_C);

		// `STREAM_C` is an orphan: written by something, claimed by nothing
		const reopened = await openGenerationRegistry(world.port, CAPS);

		expect(reopened.swept).toEqual([STREAM_C]);
		expect(world.streams.has(STREAM_C)).toBe(false);
		expect(world.streams.has(STREAM_A)).toBe(true);
	});

	it('is keyed on "the registry does not know this digest" and on no particular value', async () => {
		const world = memoryPort();
		const first = await openGenerationRegistry(world.port, CAPS);
		await first.create(idOf(STREAM_A, PROC_A));
		world.writeStreamSubtree('chain-1', 'a-later-digest-rule', STREAM_A);

		const reopened = await openGenerationRegistry(world.port, CAPS);

		// a placeholder, an orphan from some later redefinition of the digest rule,
		// and a live stream: only the CLAIM matters, so the rule generalises to a
		// cause nobody has met yet
		expect(reopened.swept).toEqual(['a-later-digest-rule', 'chain-1']);
		expect([...world.streams]).toEqual([STREAM_A]);
	});

	it('is IDEMPOTENT: a second open finds nothing to do', async () => {
		const world = memoryPort();
		const first = await openGenerationRegistry(world.port, CAPS);
		await first.create(idOf(STREAM_A, PROC_A));
		world.writeStreamSubtree('chain-1', STREAM_A);
		await openGenerationRegistry(world.port, CAPS);
		world.calls.length = 0;

		const third = await openGenerationRegistry(world.port, CAPS);

		expect(third.swept).toEqual([]);
		expect(world.calls.map((call) => call.op)).not.toContain('dropStreamSubtree');
		expect([...world.streams]).toEqual([STREAM_A]);
	});

	it('has no second entry point, so there is nothing to put on a timer', async () => {
		const world = memoryPort();
		const registry = await openGenerationRegistry(world.port, CAPS);

		// OPEN is the one moment the known set is authoritative and nothing is
		// mid-write, and it is the only moment this can run from
		expect(Object.keys(registry)).not.toContain('sweep');
		expect((registry as Record<string, unknown>).sweep).toBeUndefined();
	});
});
