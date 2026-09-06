---
'@etherfold/core': minor
---

An argument filter restricts a (contract, topic0) pair, not a topic0

`LogParseConfig.filters` is now a LIST of rules instead of a map keyed by event name. This is a BREAKING type change, pre-1.0, and it replaces a shape that could not express its own primary use case.

```ts
export type ArgumentFilter = (`0x${string}` | `0x${string}`[] | null)[];

export type FilterRule = {
	/** An event NAME (every topic0 it covers) or a canonical SIGNATURE (exactly one). */
	event: string;
	/** WHICH contracts. OMITTED means every contract in the source that declares it. */
	contracts?: `0x${string}`[];
	/** OR across the entries, AND within one entry's slots. Slots start at topics[1]. */
	match: ArgumentFilter[];
};
```

```ts
// a set of NFTs and ERC-20s, anything involving me
filters: [{event: 'Transfer', match: [[me, null], [null, me]]}]

// scoped to where a token id exists at all
filters: [{event: 'Transfer', contracts: [nft], match: [[null, null, tokenId]]}]
```

WHAT MOVED, and why the old shape had to go:

- `null` is now writable. It is what `eth_getLogs` defines as "match anything in this slot" and the only way to constrain the second or later indexed argument, so "Transfers TO me" was previously inexpressible. The runtime always passed it through; only the type forbade it.
- A filter now restricts a (contract, topic0) pair. A filtered topic0 used to be removed from the shared request outright, so "filter the NFT's Transfers and leave the ERC-20's alone" was inexpressible even in principle. The rule is now that AN ADDRESS NOBODY FILTERED IS NOT FILTERED: every address a rule did not reach is collected into a leftover request that asks for that topic0 unfiltered.
- `event` may be a canonical SIGNATURE as well as a NAME, discriminated on `(`, which an identifier can never contain. A name covers every topic0 it declares (both sides of an upgrade); a signature covers exactly one. The signature comparison is strict byte equality with viem's `toEventSignature`.
- Eight misconfigurations are REFUSED at construction, each naming a remedy, rather than silently widening or narrowing the stream.

MIGRATION. `{Transfer: [[a], [b]]}` becomes `[{event: 'Transfer', match: [[a], [b]]}]`. `filters` had exactly one consumer in this repository (`examples/event-processor-nfts`) and it is migrated in the same change, with its `as unknown as` cast deleted.

STREAM IDENTITY. The rules are canonicalised inside `resolveStreamConfig` before anything hashes them, so two spellings of one filter are one stream. A config that sets no `filters` hashes IDENTICALLY to before, pinned by a literal digest, so nothing a deployment without filters holds is re-fetched. A deployment that DOES set filters gets a new stream digest and re-fetches, which is correct rather than collateral damage: under the previous release its stream was missing every event that had no filter.

Recorded in ADR-0062, which also supersedes ADR-0031 in part, on the clause that filters are keyed by event name.
