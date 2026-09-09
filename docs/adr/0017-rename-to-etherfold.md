# The project is renamed to `etherfold`, and the scope becomes `@etherfold`

The project stops being called `ethereum-indexer` and becomes **`etherfold`**. The npm scope ADR-0014 introduced changes name with it, from `@ethereum-indexer` to **`@etherfold`**, and the flat name `etherfold` is reserved alongside it. Everything else ADR-0014 decided still holds: the move to a scope, the expand/migrate/contract migration, and the `<role>-store-<backend>` shape for storage packages. This ADR supersedes ADR-0014 only on the question of which word the scope spells.

## Why rename at all

`ethereum-indexer` is not a name, it is a category noun. It describes a hundred other projects as well as it describes this one, so it can never become distinctive no matter how long it is kept. Four years of data settles the usual counter-argument, that a descriptive name buys discoverability: the packages sit at 100 to 300 downloads a month, which is CI traffic and this repo's own consumers. The descriptive name did not win discovery, because it competes with the whole category rather than naming a thing within it.

What the name is NOT being changed for is chain scope. An early version of this argument held that "ethereum" was inaccurate because the indexer runs on any EIP-1193 chain. That is wrong: EVM expands to Ethereum Virtual Machine, and EVM chains are Ethereum chains, so the old name was accurate. It was merely anonymous.

The rename is also NOT expected to move adoption. If nothing here is used, the binding constraint is the unbuilt server split (ADR-0003 through ADR-0008), the docs and the examples, not the name. This is a cheap correction of a permanent defect, not a growth strategy, and it should be executed as one bounded pass rather than becoming a project.

## Why now

The window is open and it closes on its own.

- The two scoped packages that exist in the tree, `@etherfold/state-store-sqlite` and `@etherfold/processor-sqlite`, are **not published**. Renaming them today costs nothing; renaming them after they ship costs a second migration each.
- ADR-0014 already commits the repo to a rename-shaped migration of every package. Changing the target string while that migration is being executed is close to free, whereas doing it afterwards means paying the same cost twice.
- The last publish was 0.6.23 in March 2025, so roughly eighteen months of work is already unreleased. The rename lands in a release that was going to be a relaunch anyway.
- There is no external ecosystem to protect. The only real consumers are `stratagems` and `stratagems-snapshots`, both ours, and ADR-0014's re-export shims already cover them.

## Why `etherfold`

An indexer's job is to fold a stream of logs into derived state, and this repo's own vocabulary already says so: `CONTEXT.md` defines `EventProcessor` as "the reducer contract the core drives". `etherfold` therefore names the mechanism rather than the category, in a word that reads as a word.

Alternatives were tested against npm (flat and scope) and against the live web, and rejected for recorded reasons:

- **`evmstream`, and anything built on "stream"**: Moralis and Bitquery both ship products literally called *EVM Streams*, positioned as "instead of indexing chains yourself", which is this project's exact antithesis. Independently, `stream` is already load-bearing INTERNAL vocabulary here (`eventStream`, `ExistingStream`, `keepStream`, ADR-0006's stored *emission stream*, ADR-0003's *stream-builder* deployable, and a future `stream-store-sqlite`), so naming the whole system "stream" would shadow one of its own parts.
- **`logfold`**: collides with a published log-anomaly-detection paper of that name, and "log fold change" is standard bioinformatics jargon.
- **`statefold`**: an active open-source project of that name does event-sourced replayable state for AI agents, which is the same concept in an adjacent domain.
- **`etherstate`**: "Ethereum state" already means the world state trie, so the name would describe protocol state rather than application state.
- **`varve`, `tidemark`, `chiplog`, `escapement`, `piperoll`**: all clean and all viable, and `varve` in particular has no collisions anywhere on the web. They were passed over because a name that describes nothing needs marketing to acquire meaning, and this project would rather be legible in its ecosystem on sight.

**The Interfold was considered and is not a blocker.** The Ethereum privacy protocol formerly called Enclave rebranded to The Interfold, with FOLD as its token ticker, which puts a `-fold` neighbour in this ecosystem. It is a shared suffix across different categories, not a collision: one is a network protocol with a token, the other is a library you install from npm, and readers disambiguate at the START of a word, where `ether` and `inter` differ. The ecosystem already tolerates far heavier morpheme sharing on `ether-` itself (ethers.js, Etherscan, ether.fi, Ethernity) without confusion. The residual risk is that "fold" briefly reads as token-adjacent to someone skimming in a crypto context, which is accepted.

## Consequences

- **The mapping is mechanical**, and the directory name follows the leaf name as ADR-0014 already requires:

  | now | becomes |
  | --- | --- |
  | `ethereum-indexer` | `@etherfold/core` |
  | `ethereum-indexer-browser` | `@etherfold/browser` |
  | `ethereum-indexer-cli` | flat **`etherfold`**, bin `ei` becomes `etherfold` |
  | `ethereum-indexer-js-processor` | `@etherfold/js-processor` |
  | `ethereum-indexer-fs`, `-fs-cache` | `@etherfold/fs`, `@etherfold/fs-cache` |
  | `ethereum-indexer-utils` | `@etherfold/utils` |
  | `ethereum-indexer-server` | deprecated per ADR-0010; the new server is `@etherfold/server` per ADR-0003 |
  | `ethereum-indexer-db-processors`, `-db-utils` | deleted / retired per ADR-0010, so they are NOT renamed |
  | `@ethereum-indexer/processor-sqlite` | `@etherfold/processor-sqlite` (unpublished: renamed outright) |
  | `@ethereum-indexer/state-store-sqlite` | `@etherfold/state-store-sqlite` (unpublished: renamed outright) |

- **Old names are deprecated, never unpublished, and they get NO re-export shim.** This is a deliberate deviation from ADR-0014, which called for republishing each unscoped name as a thin re-export before deprecating it. The shim's only real function is to hand the NEW code to a consumer who upgrades an OLD name without migrating, and the only consumers that could do that are `stratagems` and `stratagems-snapshots`, both of which we own and can migrate directly. Everything already published stays installable forever, since npm does not unpublish, so "the old names keep working" is true without shipping anything. Against that, seven shim packages would have to live in the tree, be versioned and changeset-managed indefinitely, and the CLI's shim would additionally have to keep an `ei` bin alive that ADR-0017 just retired. The cost is real and the benefit accrues to nobody outside this repo. What replaces the shims is a written runbook: `work/tasks/ready/publish-etherfold-and-deprecate-old-names.md`.
- **The rename is therefore NOT transparent to an unmigrated consumer.** Anyone pinned to `ethereum-indexer@^0.6` keeps the last old release and simply stops receiving updates, and there is no version of the old name that forwards to the new one. That is the accepted trade, and it is only acceptable because the external consumer count is effectively zero (100 to 300 downloads a month, which is CI and bot traffic).
- As ADR-0014 already noted, changesets cannot express a rename, so the changelog will show new packages appearing rather than packages changing name.
- **The CLI is the ONE package outside the scope, and it takes the flat name.** `ethereum-indexer-cli` becomes plain **`etherfold`** with bin `etherfold`, so the package, the command and the project are one word. This does not reopen ADR-0014, whose argument was that a flat *prefix* across a dozen packages runs out of room; a single flat name for the single command has no such problem, and the alternative (`@etherfold/cli` owning a bin named after a package it is not called) is the surprising one.
- **The flat name goes to the CLI rather than to a library entry point**, which is the real alternative (the `viem` / `ethers` pattern, where the flat name is what you import). It loses because this project has no single library entry point: the common path is `@etherfold/browser` PLUS `@etherfold/js-processor`, and the core is rarely imported directly. There is exactly one command, so the command is where an unambiguous name belongs. The accepted cost is that someone who guesses `npm i etherfold` hoping to import something gets a CLI instead.
- **The umbrella grows in place.** When the server of ADR-0003 lands, `etherfold` gains subcommands rather than a second package sprouting a second command, and no bin ownership has to move between packages later.
- **The `named-logs` namespace is `etherfold` / `etherfold:keepState`**, replacing `ei` / `ei:keepState`. Under the flat name this now agrees with both the package name and the command, so the rule that namespaces follow package names holds without an exception.
- **The flat name and the scope are both claimed** on npm. The flat name currently holds a `0.0.0` placeholder with no bin, and the CLI publishes over it at its existing version (`0.6.30`), so no version conflict arises.
- **Packages retiring under ADR-0010 do not get renamed.** Renaming a package on a retirement path would publish a new name purely to deprecate it.
- **`named-logs` namespaces follow the package names**, so log filters change with the rename.
- **The brand mark survives untouched.** It carries no letterforms (an ether diamond of stacked index rows, cut by a beam), so only the wordmark in `lockup.svg` / `lockup-dark.svg` and the derived outlined and preview files change. Palette and Audiowide are unaffected.
- **Historical records are left alone.** The 37 files in `.changeset/` and the per-package `CHANGELOG.md` files record what was published under the old names, which remains true.
- **The repository does NOT move with the rename.** Every `jolly-roger-eth/ethereum-indexer` URL, the Pages `base: '/ethereum-indexer'`, and the `repository` / `homepage` fields are deliberately excluded from this pass and stay as they are. They all change together, later, whenever the repo moves.
- **`docs/web-config.json` now claims `https://etherfold.dev`.** Its previous value, `https://ethereum-indexer.dev`, never resolved: it was aspirational and the domain was never registered. The new value is aspirational in the same way, and `etherfold.dev` is unregistered as of this ADR.
- **The retiring packages keep their runtime footprint.** `ethereum-indexer-server` still defaults its data directory to `ethereum-indexer-data` and `.gitignore` still ignores that path, because renaming a data directory would strand the state of existing deployments of a package that is being retired anyway.
