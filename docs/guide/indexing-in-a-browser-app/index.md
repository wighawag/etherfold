# Indexing in a browser app

The shape a template wires once and every app on it inherits: **one contract, one processor, EIP-1193 from the user's own wallet, IndexedDB for the state, results consumed as stores** — and a development loop where both the contract and the processor get replaced while the tab is still open.

The reference implementation is [`examples/browser-reference/browser/main.ts`](https://github.com/wighawag/etherfold/blob/main/examples/browser-reference/browser/main.ts). It is one file, meant to be read top to bottom in one sitting and copied. This page is what you should know before you copy it.

Two things about that file are deliberate and worth stating, because they are the reason to trust it over a snippet in a document: it is **typechecked by the acceptance gate**, and every claim it makes is **asserted against a real browser** by [`verify/reference.spec.ts`](https://github.com/wighawag/etherfold/blob/main/examples/browser-reference/verify/reference.spec.ts), which needs no network — the wallet and the chain are injected into the page. Run it with `pnpm --filter browser-reference verify:browser`. See [ADR-0030](../../adr/0030-every-workspace-directory-is-typechecked-browser-execution-is-not-a-gate.md) for why that split exists.

## Two hazards that do not look like hazards

### Ask the connection for the chain, never the provider

`@etherplay/connect`'s `connection.provider` is an always-on wrapper: it routes through the chosen wallet when there is one and falls back to the chain's own endpoint when there is not, so your app has one provider either way. It is **pinned to the `chainInfo` it was constructed with**, so:

```ts
await connection.provider.request({method: 'eth_chainId'}); // ALWAYS your app's chain id
```

A chain check written against it compares a constant with itself. It passes for a wallet sitting on Polygon, and the app then indexes a mainnet address against a Polygon node — finding nothing, and looking merely slow. That bug shipped in this repository, reviewed and built green.

```ts
// ✗ never: pinned, answers your own chainInfo whatever the wallet is set to
const chainId = await connection.provider.request({method: 'eth_chainId'});

// ✓ always: the connection state reports the WALLET's own chain
const chainId = $connection.wallet?.chainId;
```

The provider is for reads (`eth_getLogs`, `eth_blockNumber`). It is not an authority on what the wallet is pointed at.

### Wire first, subscribe last

A store subscription **fires synchronously with the current value**, before `subscribe()` returns. So a callback that touches anything declared after the `subscribe` call reads it in the temporal dead zone and throws.

```ts
// ✗ throws `Cannot access 'unsubscribe' before initialization`
//   on every path where the store has ALREADY settled
const unsubscribe = connection.subscribe(($c) => {
	if (settled($c)) unsubscribe();
});

// ✓ declare with let, initialise to a no-op, defer the call
let unsubscribe: () => void = () => {};
const stop = () => setTimeout(() => unsubscribe(), 0);
unsubscribe = connection.subscribe(($c) => {
	if (settled($c)) stop();
});
```

The reason this survives testing is that the paths a human *clicks* — a wallet picker, an accounts prompt — resolve asynchronously and work fine. The paths that break are the already-settled ones: a single auto-selected wallet, a chain mismatch, no wallet at all. That is the returning user, not the first-time one.

The same trap is not limited to the `unsubscribe` handle. Attach `indexer.syncing.subscribe(...)` and `indexer.state.subscribe(...)` at the **end** of your setup, after everything they close over exists. While writing the reference, those two calls sat above the pending-transaction map they read, and the page died on load. It typechecked perfectly; the browser run caught it.

## Starting from a published snapshot: the snapshot-only mode

A browser app usually cannot rebuild its state from the chain: on a public node the historical `eth_getLogs` a backfill needs is frequently refused outright. So what the tab holds at startup has to arrive as a **published artifact**, and the supported shape of that is the **snapshot-only mode**: state seeded from a published state **snapshot**, the tab indexing forward from the snapshot's own block, and **no stream keeper at all**, so nothing is ever written or read under the stream keyspace. It is the path most browser apps should take rather than a fallback.

It is asserted end to end by [`packages/browser/test/snapshotOnlyMode.test.ts`](https://github.com/wighawag/etherfold/blob/main/packages/browser/test/snapshotOnlyMode.test.ts), which is the thing to read next to this page: the mode lands on the same state as the same run with a keeper under it, survives a reorg inside the finality window and a reload, and the empty keyspace is proved by **reading the keys** of the substrate a keeper would have used, against a kept-stream control in the same case, rather than by asserting that a function was not called.

### The trade, before the recipe: the generation is a leaf

A snapshot carries nothing below its own block. A bootstrapped store reports its **retention** floor there and refuses a revert reaching under it ([ADR-0028](../../adr/0028-a-bootstrapped-store-reports-a-floor-at-its-snapshot-and-refuses-to-revert-under-it.md)), and with no stream keeper there is no stored stream beneath the fold either. The generation is a **leaf**, and one consequence follows that you want to know before you ship rather than at the first reconfigure.

**A later processor-only change is not free.** [A generation built beside the live one](#the-same-edit-without-the-blank-app), which is how an edited processor lands without blanking the app, fetches not one log precisely because the successor re-folds the stream that is already stored. Seeded from a snapshot there is no such stream, and a snapshot is keyed to the processor version that computed it, so the successor cannot start from the snapshot you already hold either. Its state comes from a snapshot the **publisher** republishes with the new processor, and that wait is the price of the mode.

**Adding `keepStream` on top does not buy it back.** That is the reach that looks obvious and leaves exactly the same hole: a stream kept by a snapshot-seeded tab starts at the snapshot's block, so a successor still has nothing to fold below it. (It is also the one combination with a known hazard under it, a follower generation that can clear the writer's stream: [the note](https://github.com/wighawag/etherfold/blob/main/a-follower-can-self-clear-the-writers-stream-through-the-read-only-view).) What buys the free re-fold, plus revert and as-of depth below the snapshot's floor, is a stream that reaches back to your source's own start block: either indexed from that block by this tab, which is the fetch a public node will not serve, or installed from a published **stream seed**, which is the next section ([ADR-0063](../../adr/0063-a-published-stream-seed-arrives-through-its-own-loader-and-installs-through-the-keeper-seam.md), [ADR-0064](../../adr/0064-a-seed-for-another-stream-is-refused-on-an-exact-digest-and-the-refusal-names-a-direction.md), [ADR-0066](../../adr/0066-a-rolling-seed-is-trusted-by-the-host-its-build-names-not-by-a-hash-the-build-cannot-know.md)).

### How long that wait is

Measured, and quotable as fact: the reference deployment's publisher republished its state snapshot **8,198 times over 357 days**, measured from the git history of its public snapshot repository.

| gap between publishes | |
| --- | --- |
| median | 1.0 h |
| p90 / p99 | 1.2 h / 1.9 h |
| worst observed | 50.9 h |
| within 2 h / 4 h | 99.74% / 99.90% |

Read that as the floor on the wait rather than the wait itself. It measures the interval between republications of the snapshot the SAME processor computed, so a processor-only change pays it only after the publisher has deployed the new processor and re-indexed under it; the cadence bounds the last step, not the first. The tail is also what to plan the UI against rather than the median. The same cadence bounds what a freshly seeded tab fetches for itself before it is caught up: at 2.000 s/block that is **1,802 blocks at the median gap and 91,527 at the worst observed one**, all of it inside the recent range a public node does serve. Every number here is from [`work/notes/findings/what-a-published-stream-seed-costs-to-install.md`](https://github.com/wighawag/etherfold/blob/main/work/notes/findings/what-a-published-stream-seed-costs-to-install.md), which measured them.

**One half of this is measured and the other is an account, and they are worth keeping apart.** The cadence above is a measurement of a public git history, so take it as fact. That the **client** of that deployment then ran on the snapshot ALONE, with no stream underneath at all, is the maintainer's account of how one deployment was built and behaved: no measurement here shows it, and that deployment ran on this library's predecessor, so read it for the shape of a deployment and not for an API. It is a good reason to believe the mode is viable in production, offered as testimony rather than as data.

### Wiring it

```ts
import {createBrowserStateStore, createIndexerState, type GenerationContext} from '@etherfold/browser';
import {entityProcessorVersionHash, fromEntityProcessor, openAndBootstrap} from '@etherfold/processor-entities';

// Locations in priority order, freshest first: a rolling remote your build
// NAMES, then the copy EMBEDDED in this build at a relative path. That last one
// needs no host and no TLS relationship, arrives in the same bytes as the code,
// and is what makes the app start when the snapshot host is unreachable or gone.
const SNAPSHOT_LOCATIONS = [SNAPSHOT_URI, '/indexed-states/token/state.json'];

const indexer = createIndexerState({
	// Seed the FOLD. Open snapshot-aware FIRST (that is what recovers a floor an
	// earlier run recorded), then bootstrap only if this tab has never synced.
	createState: async (context: GenerationContext) => {
		const {store, outcome} = await openAndBootstrap(
			await createBrowserStateStore(tokenProcessor.entities, {databaseName: `app-${CHAIN.id}-${context.stream}`}),
			SNAPSHOT_LOCATIONS,
			{processor: entityProcessorVersionHash(tokenProcessor), finalityDepth: 12},
		);
		// A refusal is DATA rather than a throw, so render it instead of leaving an
		// unexplained empty app: {status: 'bootstrapped', at, from} | {status: 'kept-local',
		// at} | {status: 'not-bootstrapped', reason}.
		showSeedingStatus(outcome);
		return store;
	},
	createProcessor: (state) => fromEntityProcessor(tokenProcessor)(state),
});
// There is no second argument, and that ABSENCE is the whole of the mode:
// `keepStream` is how a stream keeper would arrive, the save answers `'skipped'`
// without one, and nothing is stored or read under `['stream', ...]`.

await indexer.init({provider, source, config: {stream: {finality: 12}}});
```

From there it is an ordinary indexer: it starts at the cursor the snapshot carried, re-reads that cursor's finality window without applying anything twice, and indexes forward.

**The locations are yours, and so is the risk.** The library fetches where it is pointed and judges nothing: there is no allowlist and no origin check, because a client cannot be offered a snapshot from somewhere it was not pointed at ([ADR-0066](../../adr/0066-a-rolling-seed-is-trusted-by-the-host-its-build-names-not-by-a-hash-the-build-cannot-know.md)). So the host your build names has to be trusted the way your build pipeline is trusted, and an app that lets a URL query parameter override it (as the reference deployment's `?snapshot=` does) is accepting a state source anyone with a link can choose. Nothing downstream catches that: what is checked is the processor version, the envelope format and the reorg window, while the rows themselves are taken on trust, and a snapshot that quietly leaves some out is structurally perfect. Detecting that needs the historical logs the node will not serve ([ADR-0065](../../adr/0065-a-stream-seed-is-trusted-by-a-build-pin-and-checked-for-coherence-because-omission-cannot-be-detected.md), whose omission residue ADR-0066 leaves standing).

**Pass `finalityDepth`, and publish below the tip.** A snapshot taken within the reorg window of the tip its producer had seen cannot absorb a reorg reaching under its own block, since it carries no history there. That has two halves and you own both: the publisher takes the snapshot at least the finality depth behind the tip, and the client passes `finalityDepth` so a snapshot that was not is refused as `not-bootstrapped` / `inside-reorg-window` instead of installed. Omit it and the check never runs. Give it the same finality your indexer runs with.

## Installing a published stream seed, and rendering what it did

The other published artifact: a **stream seed** puts the raw stream UNDER your state, so a later processor-only change re-folds locally instead of waiting for a republished snapshot. It is a separate decision from the snapshot above and composes with it (the snapshot seeds the fold, the seed seeds the stream), and it needs a stream keeper, which the snapshot-only mode deliberately does not have.

### The wiring, which has two shapes and one behaviour

The **documented default is the hook's `seed` option**: it sequences the install for you and publishes what it did on the stores you already subscribe to.

```ts
import {createIndexerState, keepStreamOnIndexedDB} from '@etherfold/browser';

// Ordered, freshest first, and BOTH of these live in your BUILD: a rolling
// remote your build names, then the copy embedded in the build at a relative,
// hostless path, which needs no host and is what makes the app start when the
// remote is gone.
const SEED_LOCATIONS = ['https://seeds.example/token.seed.json.gz', '/seeds/token.seed.json.gz'];

const indexer = createIndexerState(
	{createState, createProcessor},
	{
		keepStream: keepStreamOnIndexedDB('token'),
		seed: {locations: SEED_LOCATIONS},
		// For an IMMUTABLE, release-tied artifact, add the hash the producer PRINTED:
		// seed: {locations: SEED_LOCATIONS, expectedContentHash: 'sha256:…'},
	},
);

await indexer.init({provider, source, config: {stream: {finality: 12}}});
```

The **direct path** is the same capability with the sequencing in your hands, and it is fully supported:

```ts
import {installStreamSeed, resolveStreamConfig} from '@etherfold/core';

const keeper = keepStreamOnIndexedDB('token');
const outcome = await installStreamSeed(keeper, SEED_LOCATIONS, {
	source,
	// RESOLVED, and the same stream config your indexer runs with: it is half of
	// the address the stream is stored under, so `{finality: 12}` as a user spelled
	// it is not what to pass.
	streamConfig: resolveStreamConfig({finality: 12}),
});
```

**Either order is correct**, before `init()` or after it, because the install carries its own resolved stream config and sets it on the keeper before it addresses anything ([ADR-0067](../../adr/0067-the-install-is-self-sufficient-it-carries-its-address-and-refuses-a-subtree-it-did-not-empty.md)). So the hook option is ergonomics, not a safety mechanism. What is NOT free is installing after the tab has started indexing: the install writes only into an EMPTY subtree, so it comes back `not-installed` / `subtree-not-empty` and leaves what is there alone. That is loud and it is data, so clear the stream deliberately if you meant to replace it.

### What reaches your stores

No new reactive shape: a field on `syncing` and a value in the `status` phase enum.

```ts
indexer.status.subscribe(($status) => {
	if ($status.state === 'InstallingStreamSeed') showSpinner('Installing history…');
});

indexer.syncing.subscribe(($syncing) => {
	const seed = $syncing.streamSeed; // undefined when no seed was asked for
	if (seed?.status === 'seeded') show(`history from ${seed.from}, up to block ${seed.at}`);
	// `subtree-not-empty` is the ORDINARY case on every visit after the first: see below
	if (seed?.status === 'refused' && seed.reason !== 'subtree-not-empty') show(explain(seed.reason, seed.direction));
});
```

**`subtree-not-empty` is the steady state, not a problem — do not render it.** The install writes only into an empty subtree, so it succeeds ONCE. Every later page load finds the stream already there and comes back `not-installed` / `subtree-not-empty`, which is truthful (this boot installed nothing, for exactly that reason) and costs nothing (the emptiness check runs before any download, so a returning visitor fetches no artifact at all). It is the signal that seeding WORKED and is still working. An app that renders every `refused` alike will therefore show a failure banner to a perfectly healthy returning user, which is the inverse of the point — so treat this one reason as a non-event, as the snippet above does. The refusals worth showing a user are the ones about the artifact: a direction, an integrity mismatch, incoherence, a capture too close to the tip.

**A refusal is not an error, and it does not stop your app.** State still comes up from your published snapshot and indexes forward from the tip; what is lost is the stream underneath, so the generation is a leaf again ([ADR-0064](../../adr/0064-a-seed-for-another-stream-is-refused-on-an-exact-digest-and-the-refusal-names-a-direction.md)). That is why it is its own field and not `syncing.error`: an app that renders `error` as a crash must not render one for an ordinary outcome.

**The direction is yours to interpret, and only yours.** A seed for another stream is refused with a reason, and where the reason names a direction it is repeated as `direction`: `seed-covers-more` (the publisher indexes more than this build does) or `seed-covers-less` (this build indexes something the seed lacks). Your app may render "a newer version of this app may be available"; the library will not, because a deliberately narrower client is indistinguishable from a stale one and only you know which yours is.

**There is no byte-level progress, deliberately.** `installing` and one terminal state is the whole surface: the install itself is about a second on a mid-range phone in this shape, and the variable part is the download rather than the write ([the finding](https://github.com/wighawag/etherfold/blob/main/work/notes/findings/what-a-published-stream-seed-costs-to-install.md)).

**The locations are yours, and so is the risk**, which is the same sentence as for snapshots and for a sharper reason. The loader fetches where it is pointed and judges nothing, an optional `expectedContentHash` only exists for an immutable release-tied artifact, and OMISSION is not detectable at all: a seed that quietly leaves logs out is structurally perfect, and a stored stream is re-folded by every later generation, so the poison is inherited. Name a host you trust the way you trust your build pipeline ([ADR-0066](../../adr/0066-a-rolling-seed-is-trusted-by-the-host-its-build-names-not-by-a-hash-the-build-cannot-know.md)).

It is asserted end to end by [`packages/browser/test/streamSeeding.test.ts`](https://github.com/wighawag/etherfold/blob/main/packages/browser/test/streamSeeding.test.ts), against the real IndexedDB substrate.

## Telling whether the state already accounts for your transaction

Before an app lays an **optimistic update** over indexed state, it has to know whether the indexed state already contains the transaction's effects — because applied on top of a state that already has it, a non-idempotent update (a counter, a balance, an append) is counted twice.

```ts
const verdicts = indexer.checkTxInclusion([{txHash, minedAtBlock}]);
if (verdicts[txHash].status === 'included') dropOverlay(txHash); // else KEEP it
```

Your own **receipt cannot answer this**. A block height is a local opinion about a chain rather than an identity, and the receipt's block *hash* is the wrong identity: a reorg can re-include the same transaction in a different block, so comparing hashes reports "not indexed" for a transaction that *is* indexed — producing exactly the double count the check exists to prevent. The question is about the indexer's own chain, so only the indexer answers it.

Three statuses, not two. `'unknown'` is a real answer and collapsing it is what makes a wrong UI: treated as `'included'` it double-counts, treated as `'absent'` the effect briefly vanishes. Keep the overlay on anything that is not `'included'`.

**The pairing with `state` is safe in one direction.** Within one update the hook sets `syncing` before `state`, so the cursor can be one statement ahead of the rows and never behind. An overlay dropped a moment early flickers; one dropped late is counted twice. A subscriber that reads both after an update sees them agree.

Two documented limits, both following from the unconfirmed window being *sparse* (event-bearing blocks only): a transaction that emitted no indexed event can never hit, and `'absent'` means "not in the window", so do not ask about a transaction older than it. Pass `minedAtBlock` when you have a receipt to close both.

## Hot reload: two independent axes

A template with hot contract replacement has **two** things that get replaced while the tab runs, and they fail differently.

### Axis one — the processor was edited

`updateProcessor` decides whether your state survives by comparing **version hashes**, and a version hash is `${version}-${hash({entities, config})}`. **Handler code is in none of that.**

So editing a reducer and leaving `version` alone is not a change the core can see: the swap is **skipped**, the old processor object keeps running, and your edit never executes. The only complaint is a `named-logs` warning most apps never route anywhere.

```ts
const outcome = await indexer.updateProcessor(next);
outcome.stateDiscarded; // false => the swap was SKIPPED, your edit is not running
```

Make the edit land by bumping `version` in the processor, or by passing `{force: true}`. Both cost the same thing: the state is discarded and rebuilt from the start block, because the core cannot know which part of the state your edit invalidated, and "all of it" is the only answer that cannot be wrong.

Generating the version (a content hash, a build id, a git sha) is the way to stop relying on memory.

### The same edit, without the blank app

`updateProcessor` reconfigures the generation that is answering reads, so the rebuild it costs is time your app has nothing to render. `addGeneration` is the other shape: it builds a **generation** *beside* the live one, which goes on answering every read while the new fold catches up.

```ts
await indexer.addGeneration({
	createState: () => createBrowserStateStore(next.entities),
	createProcessor: (store) => fromEntityProcessor(next)(store),
});
```

A processor change does not move the fetch filter, so the new generation folds the stream that is already there and **fetches not one log**.

When the pointer moves to it is the *promotion policy*, passed to `createIndexerState` and defaulting to `on-catch-up` in every runtime:

| policy | when the new generation starts answering |
| --- | --- |
| `on-catch-up` (default) | once it reaches the cursor the canonical one had — the app never shows state going backwards |
| `immediate` | at once, before it has caught up — what you want while iterating, and an opt-in |
| `manual` | only when you call `promote(id)` |

There is deliberately **no development-versus-production default**: nothing in a browser build can detect which it is in, so the safe value is the default everywhere and `immediate` is chosen explicitly.

Under `immediate` the new generation is canonical having folded nothing, so reads are *incomplete* for a moment — and `checkTxInclusion` says so, answering `'unknown'` / `'not-synced'` rather than reporting inclusion from the generation that no longer answers. Keep your overlays on anything that is not `'included'` and this costs you nothing.

The old generation is kept, so `promote(indexer.generations[0].record)` moves the pointer **back** with no re-index and no fetch.

### Axis two — the contract was redeployed

On a local chain these apps deploy behind a **proxy**, so a redeploy does not move the address. What moves is the implementation and therefore the generated ABI — and the ABI is hashed into the indexing source, so handing the new source over is enough:

```ts
const outcome = await indexer.updateIndexer({source: {chainId, contracts: [next]}});
```

`reset()` is **not** also required; calling it would be a second full rebuild.

If the ABI did *not* change, nothing is discarded — and that is correct rather than a gap. The same signatures over the same address still mean what the indexed rows say they mean.

The case that looks like it needs a third branch — an implementation that changed what its events *mean* while keeping their signatures — does not, because it cannot happen without a **processor** change. New meaning has to be implemented by new handler code, and writing that is the developer's job. So it travels axis one: bump `version`, and the swap discards and re-indexes.

| what changed | the response |
| --- | --- |
| ABI changed, same address | `updateIndexer({source})` — discards and re-indexes |
| event *meaning* changed | edit the processor and bump `version` — axis one |
| genesis hash changed (a different chain) | reload the page |

That last row is why a template's deployments store forces `location.reload()` only on a genesis change: a different chain invalidates the provider, the cursor and the store at once, and no in-place reconfigure covers that. Everything else takes the reactive path.

### An upgrade that only adds events needs no feature

Worth knowing before you go looking for one. Decoding is by topic0 against the ABI you supply, so an upgraded implementation that emits a **new** event is indexed from block 0 simply by giving the source the union of both ABIs. Two entries at the same address also work, and merge:

```ts
contracts: [
	{abi: [Transfer], address: X, startBlock: 0},
	{abi: [Transfer, Approval], address: X, startBlock: 500},
]
// -> events indexed at that address: Transfer, Approval
```

Adding the event does move the source hash, so it costs one re-index. That is the conservative default and it is correct: the indexer cannot know whether that event could already have been emitted in the blocks it has, and if it could, those logs were never fetched, because the topic was not in the filter.

The current limit is an upgrade that **changes an existing event's signature**. Two events sharing a name but not their inputs are refused today, even though their topic0s differ. Tracked in `work/specs/tasked/an-upgraded-contract-is-indexable-from-its-first-block.md`.

### The one thing a rebuild does not do for you

A discard replays the **whole** history, including the blocks the previous implementation wrote. So a handler that merely implements the new meaning silently reinterprets pre-upgrade events under post-upgrade rules.

The upgrade block is your own knowledge, and spending it is ordinary handler code — `event.blockNumber` is on every event:

```ts
async onTransfer(state, event) {
	const weight = event.blockNumber >= UPGRADE_BLOCK ? next : previous;
	// ...
}
```

A local chain restarted with each deploy never meets this. A chain that keeps its history always does.

### Both axes report what they did

`updateProcessor`, `updateIndexer` and `reset` return a `ReconfigureOutcome`. Branch on it rather than re-deriving the rule — the rule includes `force`, the entity declarations and the source hashes, and a caller who gets that derivation wrong fails silently.

`stateDiscarded: boolean` is the whole of it for most apps. Use it to tell the user their data is being rebuilt. You do **not** need it to clear your own copy of the state: the hook re-seeds its `state` store at the moment of a discard, so subscribers never see state the core has thrown away.

`sourceInvalidation` is the verdict that one bit was collapsed from, and it is there for the caller who wants to do something other than discard:

```ts
const outcome = await indexer.updateIndexer({source});
outcome.sourceInvalidation; // SourceInvalidation | undefined
// {state: {valid: false, invalidFromBlock: 780, reason: 'entry-added'}, stream: {valid: true}}
```

Two halves, because the fetch and the fold do not depend on the same thing. `stream` is about the raw logs, fetched under a topic-and-address filter, so it survives anything that did not GROW that filter; `state` is about the fold over decoded events, so it dies whenever the decoding shape moved. A renamed non-indexed parameter is the case that proves they are two questions: `topic0` hashes types and not names, so every cached log is still right and every cached `args` is filed under a key the handler no longer reads. Each half names the block it stopped being valid from.

It is `undefined` on `updateProcessor` and `reset`, which ask no source question: a processor swap moves neither the filter nor the decode, and `reset` is a discard by fiat that also clears the cached stream.

What it is **not** is a digest comparison. `streamDigestOf` MOVES when an event is appended above the cursor, and that append is free — the verdict is what decides whether a reconfigure invalidates anything, and the digest only decides which stream a result belongs to.
