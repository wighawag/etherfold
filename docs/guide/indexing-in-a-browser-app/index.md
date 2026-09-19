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

**A later processor-only change is not free.** [A generation built beside the live one](#the-same-edit-without-the-blank-app), which is how an edited processor lands without blanking the app, fetches not one log precisely because the successor re-folds the stream that is already stored. Seeded from a snapshot there is no such stream, and a snapshot is keyed to the identity of the processor that computed it, so the successor cannot start from the snapshot you already hold either. Its state comes from a snapshot the **publisher** republishes with the new processor, and that wait is the price of the mode.

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
import {fromEntityProcessor, openAndBootstrap} from '@etherfold/processor-entities';

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
			// WHICH FOLD this snapshot has to have been computed under. An identity is
			// derived from what a processor IS and never declared by its author
			// (ADR-0086), so this is the value the PUBLISHER's deployment registered --
			// the hash of the bundle it folded with -- named by your build beside the
			// snapshot locations above.
			{processor: SNAPSHOT_PROCESSOR_IDENTITY, finalityDepth: 12},
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

**The locations are yours, and so is the risk.** The library fetches where it is pointed and judges nothing: there is no allowlist and no origin check, because a client cannot be offered a snapshot from somewhere it was not pointed at ([ADR-0066](../../adr/0066-a-rolling-seed-is-trusted-by-the-host-its-build-names-not-by-a-hash-the-build-cannot-know.md)). So the host your build names has to be trusted the way your build pipeline is trusted, and an app that lets a URL query parameter override it (as the reference deployment's `?snapshot=` does) is accepting a state source anyone with a link can choose. Nothing downstream catches that: what is checked is the processor identity, the envelope format and the reorg window, while the rows themselves are taken on trust, and a snapshot that quietly leaves some out is structurally perfect. Detecting that needs the historical logs the node will not serve ([ADR-0065](../../adr/0065-a-stream-seed-is-trusted-by-a-build-pin-and-checked-for-coherence-because-omission-cannot-be-detected.md), whose omission residue ADR-0066 leaves standing).

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

## When another tab takes the store: your tab becomes a reader

A user with your app open in two tabs is not an exotic deployment, and neither is a backgrounded tab that wakes up an hour later holding a cursor that stopped being true. Every mutation is checked against a claim inside the transaction that writes it ([ADR-0075](../../adr/0075-every-mutating-path-carries-a-writer-token-checked-in-the-transaction-that-writes.md)), so the loser writes NOTHING — and what it does about that is **demote itself to a reader**: it stops fetching, drops the in-memory cursor that is now a lie, and goes on answering reads from the store the other tab is writing.

```ts
indexer.syncing.subscribe(($syncing) => {
	if ($syncing.demotion) showQuietly('another tab is indexing; this one is up to date and reading');
});
```

**It is not an error and there is nothing to retry.** The data on screen stays correct — it is the store's, and the store is being written by whoever holds it now — which is why it is its own field rather than `syncing.error`, exactly as a refused seed is. Nothing loops: the auto-index loop stops and is not re-armed, and `startAutoIndexing()` on a demoted tab answers `false` rather than fetching a chain in order to be refused by every write it makes.

**An advance answers nothing once demoted.** `indexMore()`, `indexMoreAndCatchupIfNeeded()` and `indexToLatest()` resolve to `undefined`, which means demoted and means nothing else; `syncing.demotion` says why. A caller that ignores the return value is unaffected.

**Getting the write duty back is a fresh start, deliberately.** A store that lost is never re-claimed ([ADR-0077](../../adr/0077-the-storage-seam-splits-at-the-interface-and-the-claim-is-taken-by-constructing-a-writer.md)), so indexing again is `dispose()` and a fresh `init()` over a store built fresh — which re-reads everything, which is what makes the recovered writer correct.

**And you can ask for it.** `indexer.demoteToReader('lease-lost')` is the same code path, for an app that elects one indexing tab itself and wants the others to read. Note that it is not the opposite of `promote()`: that moves the canonical pointer between generations, this drops the write duty over the storage they all fold into ([ADR-0078](../../adr/0078-a-demotion-lives-where-the-store-does-and-an-advance-that-answers-nothing-is-how-a-driver-learns.md)).

## How your app learns the state moved

Everything above tells you how the state gets there. This is how your UI finds out it did, without inventing a polling interval.

The side that applied the block **tells** the sides that are reading, and what it says is the same in every deployment ([ADR-0083](../../adr/0083-a-reader-is-told-the-state-moved-by-a-signal-carrying-a-coherence-token.md)). Two things can be said, and they are a discriminated union on `kind` rather than one shape with optional fields, so a handler that reads `block` off a withdrawal does not compile:

```ts
type StateMoved =
	| {kind: 'applied'; block: number; coherence: string; entities: readonly string[]; generation: string}
	| {kind: 'retracted'; forkPoint: number; coherence: string; generation: string};
```

**Your whole rule is two lines.** `coherence` is an opaque **coherence token**: compare it, never parse it.

```ts
let held: string | undefined;
port.onStateMoved((moved) => {
	if (moved.coherence !== held) {held = moved.coherence; return invalidateEverything();}
	if (moved.kind === 'applied') for (const entity of moved.entities) invalidate(entity);
});
```

**Who needs this, and who does not.** An app holding `createIndexerState(...)` directly has the indexer in its own heap and already has `state` to subscribe to — that is the case that always worked, and it is why the hook itself has no `onStateMoved`. The signal is for the readers that heap does not reach: a tab whose indexer is in a worker (the default, and the `port` above), a tab that is not the one indexing, and an app pointed at a hosted indexer. On the main thread the port is `connectToIndexerHost(indexer.mainThreadHost(), {watch: false})`, which is a wire to the host that is already there rather than a second one.

Note what those two lines do **not** have to do. A reorg arrives with a rotated token, so the first line already covers it. A promotion — a different fold now answering your reads — publishes nothing of its own and shows up as a token you have never held on the next notification. And a notification you **missed** is covered by the same line at the next one, which is why nothing is buffered for you and why a producer's memory does not grow with the number of open tabs.

### Three transports, one handler

Which object you attach it to is a deployment choice, and the handler does not change:

```ts
port.onStateMoved(handler); // a tab's port to its worker (@etherfold/browser)
tabs.onStateMoved(handler); // the cross-tab channel, in a tab with no host of its own
// GET /{indexer}/state-moved -- server-sent events, from a hosted indexer, same JSON
```

That is not a promise made in prose: one parameterised suite ([`@etherfold/state-moved-conformance`](https://github.com/wighawag/etherfold/tree/main/packages/state-moved-conformance)) runs the same cases over all three and fails on the transport that drifted.

**A handler you attach part way through is told nothing until the fold moves again.** A notification is a thing that *happened*, so there is nothing current to hand you and replaying the last one would report a move that landed some time ago. What a freshly attached reader does instead is read — which is what it was going to do with the notification anyway. (`onProgress` is the opposite and deliberately so: how far the fold has got is a *state*, so subscribing to it answers with the current value.)

**A tab that is not indexing gets the same signal over the cross-tab channel.** The channel is named from the **storage identity** the fold writes into — the `databaseName` you passed to `createBrowserStateStore` — so two tabs of one app hear each other and two unrelated indexers on one origin never do:

```ts
const tabs = openStateMovedAcrossTabs({databaseName});
tabs.onStateMoved(handler); // every tab
port.onStateMoved(tabs.publish); // and, in a tab that holds a host, forward what it is told
```

Sync progress rides that same channel (`port.onProgress(tabs.publishProgress)` / `tabs.onProgress`), so a reader tab renders "syncing, 400 blocks behind" from the host's own numbers rather than a second mechanism.

### Wiring it to a cache you already use

Every client library's invalidation API is a plain callback, which is why the signal is a plain callback. With TanStack Query it is the two lines above and nothing else:

```ts
let held: string | undefined;
port.onStateMoved((moved) => {
	if (moved.coherence !== held) {
		held = moved.coherence;
		return void queryClient.invalidateQueries(); // token changed: everything you hold may be wrong
	}
	if (moved.kind === 'applied') {
		for (const entity of moved.entities) void queryClient.invalidateQueries({queryKey: [entity]});
	}
});
```

etherfold does not depend on TanStack Query, Apollo, urql or Houdini, and will not: which cache your app uses is your decision, and this is the whole of the integration.

**One thing to know before you write the narrow half.** `entities` carries entity *names* — `'token'`, `'counter'` — which is your processor's vocabulary, and no cache library knows it. The coarse line composes with every library as it stands (`queryClient.invalidateQueries()`, Apollo's `client.refetchQueries({include: 'active'})`, urql's `reexecuteOperation`), because "invalidate everything" needs no vocabulary at all. The narrow line needs a **mapping from an entity name to that library's own unit of invalidation**, and how cheap that is depends on which library you picked: a query key you already control (TanStack Query, the example above — free, as long as you key your queries by entity name), a list of query names (Apollo), or the operations you chose to re-execute (urql). None of them offers "invalidate everything of type X" for nothing. Declare the mapping once, beside your queries; do not try to derive it. See [`work/notes/findings/what-the-state-moved-payload-costs-a-normalised-cache.md`](https://github.com/wighawag/etherfold/blob/main/work/notes/findings/what-the-state-moved-payload-costs-a-normalised-cache.md) for why the payload is entity names rather than ids, and what that buys and costs.

**Do not apply the delta by hand.** The signal says *what moved* so that you re-read through the surface you already hold; it carries no rows, no mutations and no state handle, deliberately. A reader handed a delta applies it by hand, and applying a delta by hand is exactly what goes wrong at the next reorg.

## Telling whether the state already accounts for your transaction

Before an app lays an **optimistic update** over indexed state, it has to know whether the indexed state already contains the transaction's effects — because applied on top of a state that already has it, a non-idempotent update (a counter, a balance, an append) is counted twice.

```ts
const verdicts = indexer.checkTxInclusion([{txHash, minedAtBlock}]);
if (verdicts[txHash].status === 'included') dropOverlay(txHash); // else KEEP it
```

Your own **receipt cannot answer this**. A block height is a local opinion about a chain rather than an identity, and the receipt's block *hash* is the wrong identity: a reorg can re-include the same transaction in a different block, so comparing hashes reports "not indexed" for a transaction that *is* indexed — producing exactly the double count the check exists to prevent. The question is about the indexer's own chain, so only the indexer answers it.

Three statuses, not two. `'unknown'` is a real answer and collapsing it is what makes a wrong UI: treated as `'included'` it double-counts, treated as `'absent'` the effect briefly vanishes. Keep the overlay on anything that is not `'included'`.

**The pairing with `state` is safe in one direction.** Within one update the hook sets `syncing` before `state`, so the cursor can be one statement ahead of the rows and never behind. An overlay dropped a moment early flickers; one dropped late is counted twice. A subscriber that reads both after an update sees them agree.

**`state` publishes a HANDLE, not the state.** On the entities path the value the store carries is a read handle with deliberately stable identity: the same object every time, so a caller that keeps one is not defeated by an update. An update is therefore a NOTIFICATION TO RE-READ rather than a delivery of new rows, and two things follow. Read your rows through the handle inside the subscriber, rather than treating the published value as data. And do not try to diff or snapshot it: the previous value is the same object as the current one, so "what changed since last time" is not a question this store can answer, and a value captured in a closure changes underneath you. The same is true of `syncing`, which is mutated in place. If you need a before/after, derive and keep what you care about yourself at the moment you are notified.

Two documented limits, both following from the unconfirmed window being *sparse* (event-bearing blocks only): a transaction that emitted no indexed event can never hit, and `'absent'` means "not in the window", so do not ask about a transaction older than it. Pass `minedAtBlock` when you have a receipt to close both.

## Hot reload: two independent axes

A template with hot contract replacement has **two** things that get replaced while the tab runs, and they fail differently.

### Axis one — the processor was edited

`updateProcessor` decides whether your state survives by comparing the two folds' **identities**, and you do not get to state one ([ADR-0086](https://github.com/wighawag/etherfold/blob/main/docs/adr/0086-a-processors-identity-is-derived-from-its-code-and-never-declared.md)). A processor your dev server handed the tab arrives as a **module object** and has no bytes to hash, so it is named by a derivation over its **handler sources**.

So editing a reducer is a different fold, always: the swap is applied, the state is rebuilt under the new logic, and there is nothing to remember. Saving a file you did not change is the same fold, and the outcome says so.

```ts
const outcome = await indexer.updateProcessor(next);
outcome.stateDiscarded; // true  => your edit is running, over state rebuilt for it
                        // false => nothing changed, and your warm fold was kept
```

A rebuild replays from the start block, because the core cannot know which part of the state your edit invalidated, and "all of it" is the only answer that cannot be wrong. (`addGeneration`, below, is how to pay that without a blank app.)

**What the derivation can and cannot see.** It is taken over the handler **source text**, so it survives reformatting and re-ordering your handlers, and it does **not** survive minification or a change of transpiler — which is exactly why it names a module a dev server handed you and never a deployed build. A production app arrives as a self-contained bundle and is named by the SHA-256 of those octets, so the same code has a different identity as a module than as a bundle: a dev iteration and a deployed build are different generations either way.

In the other direction, it does not move for a change the source text does not carry — an edited helper your handler imports, an entity declaration you changed, behaviour decided by a value the handler captured. Pass `{force: true}` when you know better; it costs the same rebuild.

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

### Wiring that to your bundler's hot update

`reconfigureFromHotUpdate` is the same thing with the outcome your reload indicator needs. Call it from **your own** `import.meta.hot.accept(...)` handler, with the module that handler receives:

```ts
import {reconfigureFromHotUpdate} from '@etherfold/browser';

let saves = 0;

if (import.meta.hot) {
	import.meta.hot.accept('./processor.js', async (module) => {
		if (!module) return;
		const next = module.tokenProcessor;
		const report = await reconfigureFromHotUpdate(indexer, {
			// ITS OWN store. The successor folds beside the incumbent, which goes on
			// writing its own rows, and two generations sharing one `databaseName`
			// are one store by IndexedDB's own definition.
			createState: async (context) =>
				openForWriting(
					await createBrowserStateStore(next.entities, {
						databaseName: `app-${context.stream}-${++saves}`,
					}),
				),
			createProcessor: (state) => fromEntityProcessor(next)(state),
		});

		switch (report.outcome) {
			case 'registered':
				return show(`your edit is folding beside the running generation (${report.generation.processor})`);
			case 'unchanged':
				return show(`nothing changed: the handlers are the fold already running, so your warm state was kept`);
			case 'failed':
				return show(`that save did not build, and nothing changed: ${report.message}`);
		}
	});
}
```

**This library subscribes to nothing.** There is no reference to `import.meta.hot` anywhere in `@etherfold/browser`, and that is deliberate: *noticing* a change is your job, which is the same rule the server side follows — whatever watches a file stays outside the process. Your bundler is already the watcher. So a build with no HMR at all is unaffected by construction rather than by a guard, and because this is a plain function rather than a method on the indexer, the production build that eliminates your `if (import.meta.hot)` block drops it too.

**Three outcomes, because "I saved and nothing happened" otherwise has three causes.** `ReconfigureReport` is the same shape the server's `POST /{indexer}/admin/reconfigure` answers, so the arrivals share one contract ([ADR-0085](https://github.com/wighawag/etherfold/blob/main/docs/adr/0085-a-processor-may-be-pushed-as-a-content-addressed-artifact-and-its-hash-is-its-version.md)):

| outcome | what happened |
| --- | --- |
| `registered` | your edit moved the identity, and it is folding beside the generation still answering your reads |
| `unchanged` | the handler sources are the ones already running — a success, and rare, not a failure |
| `failed` | the processor could not be built (you saved mid-edit). **Nothing** was registered and the tab is exactly as it was: same generations, same pointer, still folding, still answering |

A `failed` is the ordinary case in an editing loop, so it is data rather than an exception: the next save repairs it.

**A burst stays bounded with nothing to do on your side.** The `successor` slot holds at most one, so the fourth save *replaces* the third rather than landing beside it, and the count never climbs towards the browser's cap of two generations ([ADR-0084](https://github.com/wighawag/etherfold/blob/main/docs/adr/0084-a-generation-is-held-by-named-durable-slots-and-canonical-is-merely-the-first-one.md)).

There is no `{force}` here, and there cannot be: forcing means registering a generation beside one of the same name, and the name *is* the generation. For a change the handler text does not carry, `updateProcessor(next, {force: true})` is the in-place verb — and it costs the rebuild this call exists to avoid.

### Axis two — the contract was redeployed

On a local chain these apps deploy behind a **proxy**, so a redeploy does not move the address. What moves is the implementation and therefore the generated ABI — and the ABI is hashed into the indexing source, so handing the new source over is enough:

```ts
const outcome = await indexer.updateIndexer({source: {chainId, contracts: [next]}});
```

`reset()` is **not** also required; calling it would be a second full rebuild.

If the ABI did *not* change, nothing is discarded — and that is correct rather than a gap. The same signatures over the same address still mean what the indexed rows say they mean.

The case that looks like it needs a third branch — an implementation that changed what its events *mean* while keeping their signatures — does not, because it cannot happen without a **processor** change. New meaning has to be implemented by new handler code, and writing that is the developer's job. So it travels axis one: edit the handlers, and the swap discards and re-indexes.

| what changed | the response |
| --- | --- |
| ABI changed, same address | `updateIndexer({source})` — discards and re-indexes |
| event *meaning* changed | edit the processor — axis one |
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
