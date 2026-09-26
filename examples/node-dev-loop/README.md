# node-dev-loop

The etherfold development loop, end to end on your machine: a local chain, an `etherfold node` with nothing configured, and a watcher that rebuilds your processor and uploads it on every save. The node indexes each new version beside the one answering reads and switches over once it has caught up, the same way a production deploy does (ADR-0094, ADR-0085).

## What you need

- [Foundry](https://getfoundry.sh)'s `anvil`, for the local chain. Nothing else from Foundry: the contract is committed already compiled (`contracts/Token.json`).
- The repository installed and built: `pnpm install && pnpm build` at the root.
- Optionally [zellij](https://zellij.dev), to get the whole loop in one terminal.

## Run it

```sh
cd examples/node-dev-loop
pnpm start
```

`pnpm start` opens a zellij layout (`zellij.kdl`) with every piece in its own pane. Without zellij, run the same four commands in four terminals, in this order:

```sh
pnpm chain            # anvil, one block per second
pnpm deploy:contract  # deploys contracts/Token.json and writes src/deployment.json
pnpm indexer          # etherfold node, folding into ./dev.db, answering on :2000
pnpm dev              # waits for the node, then builds and uploads on every change in src/
```

Then make something happen on chain, from any terminal in this folder:

```sh
pnpm activity                 # mint a new token to account #1 (prints its id)
pnpm activity transfer <id>   # move it to account #2
pnpm activity approve <id>    # account #1 approves account #2 for it
```

## What you should see

- **The node** starts WAITING: `started with no processor and no source, WAITING for a processor to be uploaded to http://localhost:2000/default/admin/upload`. Reads answer `503` until a processor arrives.
- **The watcher** builds `dist/processor.bundle.js` and uploads it: `etherfold upload: REGISTERED`, with the generation it registered. The node starts fetching the contract the bundle carries and folds it.
- **`curl localhost:2000/status`** shows `cursor.canonical`: which generation answers reads, whether it folds here (`held`), and where it stands. `curl localhost:2000/default/feed` shows the logs it indexed.

## The loop: edit, save, switch

Open `src/processor.ts` and change the counter's step, `+ 1` to `+ 10`, then save.

The watcher rebuilds and uploads. The bundle's sha256 is its identity (ADR-0086), so the edited file is a NEW generation: the node registers it as the successor, folds it from the stored history beside the one answering reads, and moves the pointer once it has caught up (the default `--promotion on-catch-up`). On `/status` you see two generations for a moment, then one. On a local chain that takes a few seconds, and reads are answered by the old version until the new one is level.

Save without changing the output (a comment, say) and the upload answers `UNCHANGED`: the same bytes are the same generation.

## Add an event

A contract's events are part of what a processor INDEXES, and the bundle carries them. To fold `Approval` too, add it to `EVENTS` and give it an entity and a handler:

```ts
const EVENTS = ['Transfer', 'Approval'];

// in `processor.entities`
{name: 'approval', id: ['tokenId'], fields: {approved: 'text'}},

// beside `onTransfer`
async onApproval(state: Mutations, event: {args: {owner: string; approved: string; tokenId: bigint}}): Promise<void> {
	state.set('approval', {tokenId: event.args.tokenId.toString()}, {approved: event.args.approved.toLowerCase()});
},
```

Save. A different set of events is a different fetch filter, so the new generation is on a NEW STREAM: the node fetches that stream with a second writer while the old one keeps answering, and promotes it once it has caught up (ADR-0087's 2026-09-26 amendment). `pnpm activity approve <id>` then lands in the `approval` entity.

## Restart, and roll back

- **Restart the node** (stop `pnpm indexer`, start it again). It configures nothing, so it runs what its database says: it prints `serving generation <digest>`, rebuilt from the bundle stored for it, and goes on folding, including anything minted while it was down.
- **Roll back** by undoing your edit and saving. The watcher uploads the previous bytes; the node sees a generation it already has and re-arms it as the successor, and the ordinary promotion switches back (ADR-0094).

## How it is wired

| script | what it does |
| --- | --- |
| `chain` | `anvil --block-time 1` |
| `deploy:contract` | waits for the chain, deploys the committed `Token` bytecode from anvil's first account, and writes `src/deployment.json` (chain id, address, start block). Because that file is in `src/`, the watcher then re-uploads: a different address is a different source, so a new stream. On a fresh anvil the address is always the same, so re-deploying changes nothing |
| `indexer` | `etherfold node --store sqlite --db file:./dev.db` |
| `dev` | waits for the node's `/status`, then `as-soon -w src pnpm build:upload`, which runs once at start and again on every change |
| `build` | bundles `src/processor.ts` with esbuild into one self-contained file, the only thing a node accepts |
| `upload` | `etherfold upload dist/processor.bundle.js` |
| `activity` | sends a mint, transfer or approval through anvil's unlocked accounts |

The inputs come from `.env`, which `etherfold` reads from this folder: `ETH_NODE_URI` (the chain), `ADMIN_TOKEN` (the credential the node checks and `upload` presents), `UPLOAD_TO` and `INDEXER_NAME`. The token there is for this local loop only: it is the authority to run code on the node, so never reuse it anywhere real.

`pnpm test` builds the bundle and checks it the way a node would: self-contained, makes a processor, carries the deployed contract. The repository's gate runs it, so the example cannot silently rot.

## When something goes wrong

- **`401 unauthorized` on upload**: the node and the uploader disagree on `ADMIN_TOKEN`, or the node was started without one (it says so in a `WARNING` line at start).
- **You restarted anvil**: the chain's history is new, and `dev.db` still holds the old one. Stop the node, `rm dev.db`, run `pnpm deploy:contract` again and restart the node.
- **An upload is refused as not self-contained**: the bundle still imports something. Everything the processor needs must be bundled into `dist/processor.bundle.js`; `pnpm build` does that.
