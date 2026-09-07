import type {Abi} from 'abitype';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';
import {sourceHashesOf} from '../src/internal/engine/eventRanges.js';
import {resolveStreamConfig} from '../src/internal/engine/utils.js';
import {STREAM_DIGEST_LENGTH, streamDigestOf} from '../src/stream/identity.js';
import type {IndexingSource, ProvidedStreamConfig} from '../src/types.js';

// ---------------------------------------------------------------------------
// A STREAM IS IDENTIFIED BY THE DIGEST OF ITS FILTER
// ---------------------------------------------------------------------------
// The digest is what a stream is ADDRESSED by, so every property here is about
// one of two failures, and they are not symmetric:
//
// - it MOVES when it should not: the stream forks, the whole history is
//   re-fetched and the old subtree is orphaned, silently;
// - it does NOT move when it should: one generation adopts another's stream
//   under a filter that does not match it, so logs are missing and nothing
//   reports it.
//
// The first is what the ORDERING trap causes (the entry list is sorted by
// `(startBlock, hash)` and `hash` covers the DECODING shape), and the second is
// what leaving the stream CONFIG out causes.
// ---------------------------------------------------------------------------

const A = '0x0000000000000000000000000000000000000001' as const;
const B = '0x0000000000000000000000000000000000000002' as const;

const transfer = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
	],
} as const;

const approval = {
	type: 'event',
	name: 'Approval',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'owner', type: 'address'},
		{indexed: true, name: 'approved', type: 'address'},
		{indexed: false, name: 'value', type: 'uint256'},
	],
} as const;

/** A view function: not an event, so it enters neither digest. */
const balanceOf = {
	type: 'function',
	name: 'balanceOf',
	stateMutability: 'view',
	inputs: [{name: 'owner', type: 'address'}],
	outputs: [{name: '', type: 'uint256'}],
} as const;

const sourceOf = (abi: readonly unknown[], overrides: Record<string, unknown> = {}): IndexingSource<Abi> =>
	({
		chainId: '1',
		genesisHash: '0xgenesis',
		contracts: [{address: A, abi, startBlock: 100}],
		...overrides,
	}) as unknown as IndexingSource<Abi>;

const digestOf = (source: IndexingSource<Abi>, streamConfig?: ProvidedStreamConfig) =>
	streamDigestOf(source, resolveStreamConfig(streamConfig));

/**
 * The SAME two events after a DECODE-ONLY change: `Approval`'s non-indexed
 * parameter is renamed, so its `hash` moves and its `streamHash` cannot.
 *
 * The name is chosen rather than arbitrary: it is one that makes the entry list
 * come back in a DIFFERENT ORDER, which is the condition the ordering trap needs
 * to bite (the tests below assert that precondition rather than assuming it).
 */
const approvalRenamed = {
	...approval,
	inputs: [approval.inputs[0], approval.inputs[1], {...approval.inputs[2], name: 'wad'}],
} as const;

const SOURCE = sourceOf([transfer, approval, balanceOf]);
const DECODED_DIFFERENTLY = sourceOf([transfer, approvalRenamed, balanceOf]);

describe('the digest is over the DEDUPLICATED `streamHash` values, SORTED BY THEMSELVES', () => {
	it('is exactly the digest of that set plus the stream config, and of nothing else', () => {
		// a source whose entries carry the same `streamHash` SET under a different
		// `hash` must land on the same digest: `hash` and `legacyHash` are the FOLD's
		// identity and are excluded from the stream's
		expect([...streamHashesIn(DECODED_DIFFERENTLY)].sort()).toEqual([...streamHashesIn(SOURCE)].sort());
		expect(hashesIn(DECODED_DIFFERENTLY)).not.toEqual(hashesIn(SOURCE));
		expect(digestOf(DECODED_DIFFERENTLY)).toBe(digestOf(SOURCE));
	});

	it('is STABLE UNDER A DECODE-ONLY CHANGE, even though the entry list REORDERS', () => {
		// The trap this criterion exists for: entries are sorted by `(startBlock,
		// hash)` and `hash` covers the DECODING shape, so renaming a non-indexed
		// parameter -- the exact case the two-digest split exists for -- REORDERS
		// the list while every `streamHash` in it is unchanged. A digest rolled up
		// over the list IN THAT ORDER passes every other test here and fails this
		// one, by forking a new stream and re-fetching the whole history.
		const before = streamHashesIn(SOURCE);
		const after = streamHashesIn(DECODED_DIFFERENTLY);

		// the precondition, asserted rather than assumed: the list really does come
		// back in a DIFFERENT ORDER, holding exactly the same `streamHash` values
		expect(after).not.toEqual(before);
		expect([...after].sort()).toEqual([...before].sort());

		expect(digestOf(DECODED_DIFFERENTLY)).toBe(digestOf(SOURCE));
	});

	it('is stable under ABI REORDERING', () => {
		expect(digestOf(sourceOf([approval, balanceOf, transfer]))).toBe(digestOf(SOURCE));
	});

	it('is stable under a REDUNDANT APPENDED ENTRY', () => {
		// the rollback a source generator cannot recognise: the same event appended
		// again, open-ended, which normalisation collapses away
		expect(digestOf(sourceOf([transfer, approval, balanceOf, transfer]))).toBe(digestOf(SOURCE));
	});

	it('deduplicates, so a repeated `streamHash` cannot change the digest', () => {
		// two ANONYMOUS events at one address over one range share a `streamHash`
		// (neither carries a topic0, so neither can widen what is requested) while
		// having different `hash`es
		const anonymousA = {...transfer, anonymous: true} as const;
		const anonymousB = {...approval, anonymous: true} as const;
		const one = sourceOf([anonymousA]);
		const two = sourceOf([anonymousA, anonymousB]);
		expect(new Set(streamHashesIn(two)).size).toBe(new Set(streamHashesIn(one)).size);
		expect(digestOf(two)).toBe(digestOf(one));
	});

	it('MOVES when the FETCH FILTER moves', () => {
		expect(digestOf(sourceOf([transfer]))).not.toBe(digestOf(SOURCE));
		expect(digestOf(sourceOf([transfer, approval, balanceOf], {chainId: '10'}))).not.toBe(digestOf(SOURCE));
		expect(digestOf(sourceOf([transfer, approval, balanceOf], {genesisHash: '0xother'}))).not.toBe(digestOf(SOURCE));
		expect(
			digestOf(sourceOf([transfer, approval, balanceOf], {contracts: [{address: B, abi: [transfer, approval]}]})),
		).not.toBe(digestOf(SOURCE));
		expect(
			digestOf(
				sourceOf([transfer, approval, balanceOf], {contracts: [{address: A, abi: [transfer], startBlock: 200}]}),
			),
		).not.toBe(digestOf(SOURCE));
		// a declared block range is part of the filter too
		expect(digestOf(sourceOf([{...transfer, lastBlock: 500}, approval, balanceOf]))).not.toBe(digestOf(SOURCE));
	});
});

describe('the digest ALSO covers the STREAM CONFIG', () => {
	it('MOVES on a stream-config change, so the old stream is left alone rather than adopted', () => {
		// `alwaysFetchTimestamps` and `alwaysFetchTransactions` each change WHAT IS
		// STORED, so a stream keyed on the filter alone would hand a generation
		// logs the invalidation verdict has already declared invalid -- and the only
		// remedy, clearing the stream, destroys what the live generation answers
		// from.
		expect(digestOf(SOURCE, {alwaysFetchTimestamps: true})).not.toBe(digestOf(SOURCE));
		expect(digestOf(SOURCE, {alwaysFetchTransactions: true})).not.toBe(digestOf(SOURCE));
		expect(digestOf(SOURCE, {alwaysFetchTimestamps: true})).not.toBe(digestOf(SOURCE, {alwaysFetchTransactions: true}));
		// `parse.filters` narrows which events are parsed and kept at all
		expect(digestOf(SOURCE, {parse: {filters: [{event: 'Transfer', match: [[A]]}]}})).not.toBe(digestOf(SOURCE));
		expect(digestOf(SOURCE, {finality: 5})).not.toBe(digestOf(SOURCE));
	});

	it('is over the RESOLVED config, so an unset default is the same stream as the default written out', () => {
		// `resolveStreamConfig` fills `finality`, and `sourceInvalidationOf`
		// compares the RESOLVED config hash. A digest over the provided form would
		// make `{}` and `{finality: 17}` two streams the rest of the system calls
		// one.
		expect(digestOf(SOURCE, {})).toBe(digestOf(SOURCE, resolveStreamConfig(undefined)));
	});

	it('does NOT MOVE for a config that sets no `filters`, which is what the rule redesign owed everyone else', () => {
		// A LITERAL, and it has to be one: the argument-filter surface changed shape
		// (ADR-0062) and the rules are now CANONICALISED before they are hashed, so
		// the only way to state "nobody who does not use filters re-fetches anything"
		// is to pin the bytes. This value was computed BEFORE that change landed.
		// It moving is a full re-index for every deployment on this shape, so it is
		// never to be updated to match a new answer.
		expect(digestOf(SOURCE)).toBe('7862e817c01771a7b3b21739b916856c');
		expect(digestOf(SOURCE, {})).toBe('7862e817c01771a7b3b21739b916856c');
		expect(digestOf(SOURCE, {parse: {}})).toBe(digestOf(SOURCE, {parse: {filters: []}}));
	});

	it('does not move when a rule is written a DIFFERENT WAY with the same meaning', () => {
		// the rules are canonicalised into the resolved config exactly as `finality`
		// is defaulted into it, so reordering two rules -- which changes not one
		// request -- is the same stream and not a re-fetch of the whole history
		const rules = {
			parse: {
				filters: [
					{event: 'Transfer', match: [[A]]},
					{event: 'Approval', match: [[B]]},
				],
			},
		};
		const reordered = {
			parse: {
				filters: [
					{event: 'Approval', match: [[B]]},
					{event: 'Transfer', match: [[A]]},
				],
			},
		};
		expect(digestOf(SOURCE, reordered)).toBe(digestOf(SOURCE, rules));
		// and a trailing wildcard constrains nothing, so it is the same stream too
		expect(digestOf(SOURCE, {parse: {filters: [{event: 'Transfer', match: [[A, null]]}]}})).toBe(
			digestOf(SOURCE, {parse: {filters: [{event: 'Transfer', match: [[A]]}]}}),
		);
	});

	it('does not depend on key ORDER or on an explicit `undefined`', () => {
		expect(digestOf(SOURCE, {alwaysFetchTimestamps: true, finality: 5})).toBe(
			digestOf(SOURCE, {finality: 5, alwaysFetchTimestamps: true}),
		);
		expect(digestOf(SOURCE, {alwaysFetchTransactions: undefined})).toBe(digestOf(SOURCE));
	});
});

describe('the hash is WIDE, SYNCHRONOUS, and rendered FIXED-LENGTH', () => {
	it('returns a value rather than a promise', () => {
		const digest = streamDigestOf(SOURCE, resolveStreamConfig(undefined));
		expect(typeof digest).toBe('string');
		expect((digest as unknown as {then?: unknown}).then).toBeUndefined();
	});

	it('is 128 bits, rendered as fixed-length lowercase hex usable as a key element', () => {
		expect(STREAM_DIGEST_LENGTH).toBe(32);
		for (const source of [SOURCE, sourceOf([transfer]), sourceOf([approval], {chainId: '31337'})]) {
			const digest = digestOf(source);
			expect(digest).toMatch(/^[0-9a-f]{32}$/);
			expect(digest).toHaveLength(STREAM_DIGEST_LENGTH);
		}
	});

	it('is `viem`\u2019s `sha256` truncated, with NO async digest and NO second implementation', () => {
		const source = readFileSync(new URL('../src/stream/identity.ts', import.meta.url), 'utf-8');
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
		expect(code).toContain(`from 'viem'`);
		expect(code).toMatch(/\bsha256\b/);
		// no `crypto.subtle` (asynchronous, secure-context) and no native fast path
		// beside a pure-JS fallback: two implementations that must agree BYTE FOR
		// BYTE give different stream ADDRESSES on different browsers, which is the
		// silent history-orphaning this digest exists to prevent
		expect(code).not.toMatch(/crypto|subtle|await|async|Promise/);
		// and not the 32-bit change DETECTOR: as a KEY a collision is silent data loss
		expect(code).not.toMatch(/simple_hash\(/);
	});

	it('is the ONLY implementation of ITSELF, and the only other digest identifies something else', () => {
		// One implementation OF ONE DIGEST, never a second one beside it: two that must
		// agree BYTE FOR BYTE would put a stream at two different ADDRESSES, and the
		// disagreement would show up as a re-fetch of the whole history rather than as
		// an error.
		//
		// `generation/identity.ts` is the one other digest site and is NOT a second
		// implementation of this one: it identifies a stream PLUS THE FOLD OVER IT, a
		// different value that nothing addresses storage by, and it is built ON this
		// digest rather than beside it (a stream digest goes IN). Anything else
		// appearing in this list is the failure above.
		//
		// `stream/seed.ts` is the third, admitted on the same test and not on
		// convenience: it hashes a DOCUMENT's octets (`streamSeedContentHash`, the
		// integrity value a build may pin against an immutable artifact, ADR-0066).
		// It takes bytes rather than a source and a config, it truncates nothing, and
		// no keyspace anywhere is addressed by it -- so it cannot put a stream at two
		// addresses, which is what this guard exists to prevent. It uses the SAME
		// primitive deliberately, because a second one would be a second thing a
		// producer and a loader must agree on.
		const root = fileURLToPath(new URL('../src/', import.meta.url));
		const hashing = filesUnder(root).filter((file) => /\bsha256\b/.test(readFileSync(file, 'utf-8')));
		expect(hashing.map((file) => file.slice(root.length))).toEqual([
			'generation/identity.ts',
			'stream/identity.ts',
			'stream/seed.ts',
		]);
		// ... and the one that ADDRESSES is still alone in doing so: nothing else
		// truncates to the digest's width.
		const truncating = hashing.filter((file) =>
			/slice\(2, 2 \+ STREAM_DIGEST_LENGTH\)/.test(readFileSync(file, 'utf-8')),
		);
		expect(truncating.map((file) => file.slice(root.length))).toEqual(['stream/identity.ts']);
	});

	it('produces no collision across a corpus of realistic sources', () => {
		const digests = new Set<string>();
		let counted = 0;
		for (let contract = 0; contract < 40; contract++) {
			const address = `0x${(contract + 1).toString(16).padStart(40, '0')}` as const;
			for (let startBlock = 0; startBlock < 15; startBlock++) {
				for (const abi of [[transfer], [approval], [transfer, approval]]) {
					for (const streamConfig of [
						undefined,
						{alwaysFetchTimestamps: true},
						{alwaysFetchTransactions: true},
						{finality: 5},
					] as (ProvidedStreamConfig | undefined)[]) {
						const source = sourceOf(abi, {contracts: [{address, abi, startBlock: startBlock * 1000}]});
						digests.add(digestOf(source, streamConfig));
						counted++;
					}
				}
			}
		}
		expect(digests.size).toBe(counted);
	});
});

/** Every `streamHash` a source's entries carry, in the order the entry list has them. */
function streamHashesIn(source: IndexingSource<Abi>): (string | undefined)[] {
	return sourceHashesOf(source).map((entry) => entry.streamHash);
}

function hashesIn(source: IndexingSource<Abi>): string[] {
	return sourceHashesOf(source).map((entry) => entry.hash);
}

/** Every `.ts` under a directory, in a stable order. */
function filesUnder(directory: string): string[] {
	return readdirSync(directory, {withFileTypes: true})
		.sort((a, b) => (a.name < b.name ? -1 : 1))
		.flatMap((entry) =>
			entry.isDirectory()
				? filesUnder(join(directory, entry.name, '/'))
				: entry.name.endsWith('.ts')
					? [join(directory, entry.name)]
					: [],
		);
}
