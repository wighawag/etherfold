# A generation's CODE is stored beside its state, and goes with it

A generation is a stream plus a fold over it, and the fold is code. A Node deployment redeployed with a new processor holds no engine for any other generation, so a revert moves the pointer to a state that answers reads and can never advance again, and a restart-upgrade freezes the incumbent's answers for the whole catch-up. We decide that on a NODE deployment **each generation's bundle is stored in the database beside its state, instantiated when that generation has to fold, and deleted when the generation is deleted.** Holding a generation then means holding something runnable rather than something readable.

These decisions were made in the spec `a-generation-retains-the-code-that-folds-it` and are relocated here when it was tasked, so the rationale outlives the spec's launch snapshot.

## The decisions

**The bytes live in the DATABASE, beside the generation's state.** One named indexer's database then holds everything a generation is, the grouping ADR-0053 already chose for state, and a generation's storage is reclaimed by one mechanism rather than two.

**Where in the database: a column on the generation's own REGISTRY ROW** (`_generations.bundle`), not a table inside its state namespace. This paragraph first said "one namespace", which read as the state namespace; it was corrected in place when the storage was built (`a-generation-keeps-the-bundle-that-folds-it`), before any code had followed the earlier wording. The row is the right home for two reasons. It is written by the SAME guarded statement that registers the generation, so no crash can leave a registered generation with no code or code with no generation; and it is removed by the SAME `DELETE` that removes the record, so every path that deletes a generation takes the bytes without knowing they exist. The state namespace is the state store's (ADR-0053 keeps the registry out of it on purpose), and a bundle is not state: putting it there would have made the bytes depend on the host's `dropState`, which runs after the registry commit and is a second step that can fail on its own.

**A bundle dies with its generation.** Whatever deletes a generation (a `reclaim`, a replaced successor, a drop on promotion) takes its bytes with the row and the state namespace. Nothing retains an artifact whose generation is gone, so retention is bounded by the registered generations, which the caps already bound, and `predecessor` retention costs exactly one extra bundle rather than an unbounded history.

**A bundle is instantiated when its generation has to FOLD, not eagerly.** Loading every registered generation at open would mean live engines for generations nobody is reading. The canonical generation answers every read, so it is needed from open; a `predecessor` is needed at the moment a revert moves the pointer onto it, which is when its answers start mattering.

**The bytes are the ones ADR-0085's artifact already is.** Identity is the hash of those bytes (ADR-0086), so what is stored is exactly what names the generation, and there is one representation of "a processor" whether it was read from disk, pushed, or retained.

**Instantiating is the HOST's, injected, and never `core`'s.** The loader lives in `@etherfold/utils`, which depends on `@etherfold/core`, so `core` cannot call it. The host supplies how to turn stored bytes into a fold, the same way it already supplies `dropState` and `readStateCursor`.

**A generation SAYS whether it can fold here, and a stall is REPORTED.** `GET /{indexer}/admin/canonical-generation` gives each generation `folding`: `held` (this process folds it), `instantiable` (its stored bundle can be instantiated when it has to fold) or `frozen`, with the reason beside it (`no-bundle`, `no-instantiator`, `instantiation-failed`, `stream-not-fetched`). Without it, a revert target that resumes and one that never advances again read identically, which is the choice between two states an operator cannot tell apart. `instantiable` is a claim made WITHOUT running the code, because proving it would be the eager instantiation rejected below; an attempt that then fails is remembered by the process and reported as `instantiation-failed`. That is also how the one state this ADR can still leave silent is reported: a canonical generation whose stored code cannot be built at `open`, where the deployment starts and serves it frozen rather than refusing to start (`a-generation-says-whether-it-can-run-here`).

## Where it does NOT apply

**Not in a browser tab** (ADR-0089): a tab holds no `predecessor`, and could instantiate retained bytes only through a service worker. **Not on a Cloudflare Worker** (ADR-0091): a Worker refuses every in-isolate route from bytes to running code.

## Considered options

**Retain the author's source FILE instead.** Rejected: a processor module is an entry point, not a unit. Re-importing a saved V1 entry point inside a process whose dependencies are now V2's yields neither version, while its identity would still say V1.

**Make bundling optional.** Rejected: two classes of generation, resumable and frozen, differing invisibly until the moment the difference matters.

**Instantiate every slotted generation at open.** Rejected for the reason above: live engines for generations nobody is reading.
