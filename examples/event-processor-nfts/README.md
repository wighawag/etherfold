# event-processor-nfts

Which NFTs an account owns, written as an etherfold processor, and a browser app that indexes it in a tab — reading the chain through the user's own wallet.

## Run it

```sh
pnpm --filter event-processor-nfts browser
```

That is the whole command. It starts a Vite dev server and prints a `http://localhost:5173/` URL; open it. There is no server to run, no database to provision and no API key.

With a browser wallet installed it indexes **your** NFTs, reading through your wallet's node. With no wallet, or to look at someone else's tokens, name an account:

```
http://localhost:5173/?account=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&via=endpoint
```

## What you should see

- **Indexing** — `NFTs of 0x… on chain 1, from block <n>`.
- **Reading through** — the wallet you picked, or the public endpoint. This is the line that says whether the demo is decentralised or merely convenient.
- **State lives in** — `retention: unbounded, as-of reads: yes, survives a reload: yes`. The store's own capability report, read before anything is asked of it.
- **Progress** — climbs to `block N / N (100%)` and then keeps pace with the chain.
- **Same-signature ERC-20 logs** — see below. On a 40,000-block window over vitalik.eth this reads `41 log(s) … refused`, against **one** genuine NFT transfer.
- **This page load** — `indexed from the start block (<n>): no cursor was found`.

Now **reload the tab**. Everything is still there, and the last line changes to:

```
resumed: the first fetch of this page load asked for block 25831271, not 25791283
```

That is the point of the whole example. The rows and the sync cursor live in the same IndexedDB database and are written in the same transaction, so a reopened tab continues instead of re-indexing. Both runs end on the same rows, which is why the page says which of the two happened: nothing in the state can tell you.

### Options

| parameter | default | |
| --- | --- | --- |
| `account` | your connected account | whose tokens to index. Given, no connect prompt appears — see below |
| `via` | `wallet` | `endpoint` reads through `rpc` instead of the wallet |
| `rpc` | `https://rpc.mevblocker.io` | the endpoint used when `via=endpoint`, or when no wallet is present |
| `blocks` | `20000` | how far behind the tip to start |

The start block is computed once and remembered in `localStorage`, because it is part of the indexing source and the source is hashed into the sync context: a start block that drifted with the chain tip would make every reload a different deployment and discard the state as stale.

## Two wallet target steps, and why both are here

How much of the wallet is needed depends on whose tokens are being indexed:

- **`?account=` given** — the address is already known, so nothing about your accounts is needed. The wallet is only a **node**. That is `targetStep: 'WalletChosen'` with `selectWallet()`, which picks a wallet over EIP-6963 and routes reads through it **without ever calling `eth_requestAccounts`**. No permission popup to read a public chain.
- **no `?account=`** — the address *is* yours, so the accounts must be requested: `targetStep: 'WalletConnected'` with `connect()`.

Asking for accounts in the first case would be permission theatre. Wallet discovery is [`@etherplay/connect`](https://www.npmjs.com/package/@etherplay/connect)'s job, not this example's and not `@etherfold/browser`'s — an indexing package takes an EIP-1193 provider and stays out of wallet UX.

**`via=wallet` has a cost, and the page shows it.** Reading through an extension that relays (Coinbase Wallet talks to `wss://www.walletlink.org/rpc` even as an extension) turns a few thousand `eth_getLogs` into a crawl. `?via=endpoint` is the escape hatch, and which one served the reads is on screen rather than guessed at.

## The ERC-20 collision, which is the interesting part

`Transfer(address,address,uint256)` hashes to the **same `topic0`** for ERC-20 and ERC-721. Indexing one account's tokens means filtering that signature across *every* address, so ERC-20 transfers are necessarily caught too — and on a real account they **outnumber the NFT ones**.

They differ only in arity: ERC-721 indexes the token id (4 topics), ERC-20 leaves the value in data (3 topics). So `decodeEventLog` *fails* rather than reading a balance as a token id, the core records `decodeError` on the event, and the engine routes it to `handleUnparsedEvent` instead of `onTransfer`. The example counts them and puts the number on screen, because a silent drop invites a reader to wonder why a token is missing.

## Choosing where the state lives

One line, in `browser/main.ts`:

```ts
const store = await createBrowserStateStore(NFTProcessor.entities, {databaseName: `etherfold-nfts-${chainId}-${account}`});
```

Versioned rows in IndexedDB: the browser default, decided on measurement in [ADR-0024](../../docs/adr/0024-indexeddb-is-the-browser-default-until-four-things-are-true-at-once.md). Comment it out and uncomment the alternative directly below it to get `PatchStateStore` — current state as a plain object, history as immer reverse patches. **The processor does not change**: not a handler, not a declaration, not an import. What changes is what the page reports:

```
State lives in   retention: revert-only, as-of reads: no, survives a reload: NO (memory-only, ADR-0023)
```

The light store is memory-only by design ([ADR-0023](../../docs/adr/0023-the-patch-store-is-memory-only-and-refuses-a-revert-it-cannot-complete.md)), so a reload legitimately starts over — read off `store.capabilities` at startup rather than discovered from an empty tab.

## Why there are two entities

```ts
{name: 'nft',       id: ['tokenAddress', 'tokenID'],          fields: {owner: 'text'}}
{name: 'ownership', id: ['owner', 'tokenAddress', 'tokenID'], fields: {}}
```

`nft` answers *"who owns this token"*. This example asks the opposite — *"which tokens does this account own"* — and that **cannot** be served from `nft`, because `owner` is a field rather than part of the key.

The seam's only set read is a **prefix of the declared id plus a required limit** ([ADR-0021](../../docs/adr/0021-the-handler-seams-only-set-read-is-a-bounded-id-prefix-listing.md)), so a question that is not a prefix of some id has no cheap answer — it would be a full scan, which is exactly what the bound exists to make impossible. The answer is a second entity keyed the way the question is asked. It carries no fields: the id *is* the fact.

This is the modelling rule the spec states as *"key children by something naturally unique, never by a dense array position"*, met in the smallest real case.

## The same processor, on a server

The claim this example exists to make is that `src/entities.ts` names no backend. Here is that claim as a command: the file the tab runs, folded by `etherfold build` into SQLite, with **not one line of it changed**.

```sh
pnpm --filter event-processor-nfts build:bundle
NFT_CONTRACT=0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d NFT_START_BLOCK=21000000 \
  pnpm --filter event-processor-nfts build:db -n https://rpc.mevblocker.io
```

(`build:bundle` is the esbuild step below, which is what `build:db` needs first; `build:db` is the `etherfold build` that produces `nfts.db`.)

`src/cli.ts` is the whole difference, and it adds no indexing logic: it imports `NFTProcessor` as-is and says what to index per chain. A browser page needs neither, because `browser/main.ts` passes both at the call site.

### A processor IS a bundle, and that is why there is a bundling step

`--processor` is given `dist/cli.bundle.js`, not `dist/cli.js`. A `tsc` output still imports its ABI and its sibling modules, so its dependency closure is not in it: it is an entry point rather than a unit, it cannot be handed to another process or re-instantiated after a restart, and there is nothing to hash. A bundle is all three, and **the hash of its bytes IS the identity of the fold it produces** ([ADR-0086](../../docs/adr/0086-a-processors-identity-is-derived-from-its-code-and-never-declared.md)). Edit a handler and the bytes move, so the identity moves, so it is a new generation: there is no field to remember to bump, which is what this example used to be teaching.

One command produces it, and it is the command the rest of the repository uses:

<!-- bundle-command: the line in the fence below is CHECKED against the refusal the CLI emits, by `packages/cli/test/theDocsAndTheRefusalNameOneBuildCommand.test.ts`. It is an INSTANCE of the documented command; the rule about its flags lives once, in `packages/cli/README.md`. -->

```sh
esbuild src/cli.ts --bundle --format=esm --minify --outfile=dist/cli.bundle.js
```

`--minify` is not a size preference: un-minified esbuild output carries a `// <path>` banner per module, so the **building machine's directory layout** ends up in the bytes and two machines building one source disagree about which generation they are. That, the rule that pins the bundler's version AND its flags, and what to do about minified stack traces are stated once, in [the CLI's own README](../../packages/cli/README.md#producing-the-processor-bundle).

This package's `build:bundle` script runs that command through the workspace's own copy of esbuild, so the example adds no dependency of its own. In your project, install esbuild and run it directly.

What you should see: block counters climbing (`21000123 / 21456789`), then the process **exits 0** at the tip — it is a one-shot, not a server. What lands is `nfts.db`, holding the same two entities the tab keeps in IndexedDB:

```sh
sqlite3 nfts.db 'select * from counter'          # transfers, and the refused ERC-20 lookalikes
sqlite3 nfts.db 'select * from nft limit 5'      # who owns which token, with its block-validity range
```

| flag | |
| --- | --- |
| `--store sqlite` | REQUIRED, and it names where the state goes: versioned rows in a libSQL database, with the sync cursor written in the same transaction as the block it describes ([ADR-0027](../../docs/adr/0027-the-sync-cursor-lives-behind-the-storage-seam-as-an-opaque-string.md)) |
| `--db file:./nfts.db` | a libSQL url. `libsql://…` points the same command at Turso |
| `--retention <blocks>` | how far back superseded versions are kept, in BLOCK numbers. Nothing prunes automatically: pruning is a call a host schedules ([ADR-0022](../../docs/adr/0022-pruning-is-a-call-the-host-schedules-not-a-side-effect-of-a-write.md)) |

Stop it with `Ctrl-C` half way and run it again: it continues from the cursor in the database rather than re-indexing, for the same reason the tab resumes on reload. `test/cli.test.ts` runs this whole path against a fake node, so "the browser's processor runs under the CLI" is checked rather than claimed.

**To keep it current instead of stopping at the tip, swap one word.** `etherfold run` is the same command with the same flags, plus an HTTP surface: it follows the chain rather than exiting, and `GET /status` reports a cursor that advances while it works.

```sh
NFT_CONTRACT=0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d NFT_START_BLOCK=21000000 \
  pnpm --filter event-processor-nfts exec etherfold run \
  -p ./dist/cli.bundle.js --store sqlite --db file:./nfts.db --port 2000 \
  -n https://rpc.mevblocker.io
```

The processor file is still not one line different, which is the point: which deployment shape you run is a flag, and `test/cli.test.ts` asserts the same three facts under `run` that it asserts under `build`.

**One collection, not every address.** The browser app indexes *one account's* tokens across every collection, which it does with a topic filter it passes to the indexer; a command line has no way to express that, so the CLI entry indexes one contract instead. Point `NFT_CONTRACT` anywhere; `NFT_START_BLOCK` is a recent block rather than the collection's deployment, because the first sync is what you wait for.

## What is in `src/`

| file | |
| --- | --- |
| `entities.ts` | the processor: an `EntityProcessor` (`@etherfold/processor-entities`), declared entities written through a `MutationContext`, kept in whichever `StateStore` the deployment chose |
| `cli.ts` | the entry the bundle is built FROM. Not a second processor: it imports `entities.ts` unchanged and adds only what to index per chain |
| `eip721.ts` | the ABI |

`entities.ts` is what the browser app runs, and it is the same object a server runs against SQLite: nothing in it names a backend.

This example used to carry a second processor, `index.ts`, writing the same question against a free-form object mutated as an immer draft. That authoring path is deleted ([ADR-0037](../../docs/adr/0037-one-processor-model-retire-the-js-object-path.md)); there is one processor model now, and this is it.

## Verifying it

```sh
pnpm --filter event-processor-nfts verify:browser
```

Drives the built app in a real Chromium against the live chain, over six scenarios: endpoint-only, a single chosen wallet, the multi-wallet picker, the connected-account path, a wallet on the wrong chain, and no wallet at all. It stubs EIP-6963 wallets that proxy to a real endpoint, so "reads routed through the wallet" is *counted* rather than assumed.

**It checks its own health first, and that is not decoration.** Every request must finish, and any `content-length` must equal the bytes received. A static server that returns `200` headers and then never delivers the body makes `import()` hang forever with an empty console and `readyState` stuck at `interactive` — symptoms indistinguishable from a library bug, and the reason this file exists. When the harness is at fault it says `HARNESS UNHEALTHY` and refuses to blame the application.

## Building

```sh
pnpm --filter event-processor-nfts build:bundle   # the processor BUNDLE the CLI runs, to dist/cli.bundle.js
pnpm --filter event-processor-nfts build          # tsc, for type declarations and the browser app's imports
pnpm --filter event-processor-nfts browser:build  # the browser app, to dist/browser/
```
