# @etherfold/state-store-conformance

## 0.1.1

### Patch Changes

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- Updated dependencies [da289e2]
- Updated dependencies [8bb063e]
- Updated dependencies [0bf9dc7]
- Updated dependencies [c0d694f]
  - @etherfold/state-store@1.0.0

## 0.1.0

### Minor Changes

- ff393f7: The last two reads that answered plausibly now refuse, or answer whole.

  Both were the same bug wearing two hats: a read that could not be served came back as `undefined`, which at this seam is not a shrug but a STATEMENT -- the block is fine and the entity was absent from it -- and it is what a caller acts on normally.

  **An `at` that is not a block number is refused** (`InvalidBlockNumberError`, `@etherfold/state-store`). `getAsOf('token', {id: '1'}, {hash: '0x64'})` on a backend with no addressing layer used to pass the retention check, compare an object against every version range, match nothing, and report the token as absent at a block nobody had named. The guard is `assertBlockNumber`, called first thing inside `assertRetained`, so it is written ONCE and every backend whose as-of reads take a block number inherits it (memory, patch, IndexedDB) across `getAsOf` and `listAsOf` alike, rather than three copies drifting.
  - **It is a `TypeError`, deliberately outside the `BlockUnavailableError` family.** Every member of that family is a fact about the STORE (the address resolved to no block; the versions are outside retention), and a caller acts on one by re-pinning or widening retention. A non-number `at` is a fact about the CALL: no store configuration makes it answerable, so it is a programmer error and it does not get swallowed by a `catch (e) { if (e instanceof BlockUnavailableError) ... }` written for the other thing. It comes BEFORE the retention check for the same reason: a `revert-only` store answering "not retained" would send its caller off to widen a window that was never the problem.
  - **`@etherfold/state-store-sqlite` keeps its richer addressing** (a height, `{hash}`, `{timestamp}`), because it resolves to a block number before the seam sees one. Its HEIGHT axis now throws the same `InvalidBlockNumberError` (via the seam's shared `isBlockNumber`) instead of a bare `Error`, with the same message it had; `NoSuchBlockError` still answers an address that resolves to no recorded block.

  **`MutationContext.get` answers with a WHOLE row for a key staged in the same block.** It returned `{...staged.values}`, which is only what the handler passed to `set`, so an id column and a declared field the write did not list were `undefined` for a row written earlier in the SAME block and present for one written in an earlier block: the shape of a row depended on when it was read. `get` now builds a staged row through `stagedRow`, the construction `list` already used for exactly this reason, so the two cannot drift apart again and a handler cannot read a field that is only sometimes there.

  Both are in the conformance suite (`@etherfold/state-store-conformance`), so a new backend inherits them: `versioned reads` gains the refusal (asked of every backend, whatever addressing sits above it), and `read-your-writes within a block` gains the row shape plus a case pinning that `get` and `list` agree about a staged row.

- 4e75014: **An entity store can start from state somebody else computed, and it stays honest about the history it never received** (ADR-0028).

  This is the entity path's half of a capability the free-form path has always had: `keepStateOnIndexedDB(name, remote)` takes one or more published locations, asks each how far it has got, uses the furthest, prefers LOCAL state when local is already ahead, and skips an unreachable mirror rather than dying. A client that bootstraps comes up near the tip instead of replaying every log the contract ever emitted.

  **`@etherfold/state-store`** gains the snapshot envelope and the store handle that keeps it honest:
  - `StateSnapshot` -- `{format, processor, savedAt, takenAt, cursor, rows}`, deliberately shaped like the CLI's file envelope so a reader of one recognises the other. `rows` are the LIVE rows at `takenAt`, and `SnapshotHead` is the same envelope without them, which is what a client fetches to choose between mirrors.
  - `openSnapshotAware(store)` -- the handle a deployment that may bootstrap uses on EVERY boot (it migrates the store itself). `.bootstrap(snapshot, {processor})` installs the rows and their cursor as one `applyBlock`, and records where the contents came from under a second cursor-port key (`SNAPSHOT_ORIGIN_KEY`), so a reload is as honest as the first run.
  - The honesty: a bootstrapped store reports its retention as a **window whose oldest block is the snapshot's**, never the `unbounded` a freshly migrated store would claim, and an as-of read below that block is refused with `BlockNotRetainedError` instead of answering `undefined` -- which would read as "the entity was absent then", an ordinary answer a caller acts on normally, and wrong. The floor is intersected with whatever the deployment configured, and a store that answers no historical read at all is left saying exactly that.
  - `RevertBeyondSnapshotError` -- a reorg reaching below the snapshot is refused loudly and changes nothing. There are no superseded versions under the snapshot to reopen at any price, and a partly undone reorg is a plausible state nothing downstream can tell apart from a correct one.
  - `SnapshotProcessorMismatchError` / `SnapshotFormatError` -- a snapshot computed by another processor version, or in an envelope this build does not read, is refused rather than loaded.

  **`@etherfold/processor-entities`** gains the client side:
  - `bootstrapFromSnapshot(store, locations, {processor, finalityDepth?, fetch?})` -- mirrors, most-advanced-wins, prefer-local, fail over on error. Two deliberate differences from the free-form keeper: failover walks EVERY remaining candidate in descending order (the keeper tries the winner and one more), and a snapshot from another processor version is not a candidate at all. Given a `finalityDepth`, a snapshot taken inside the reorg-eligible window of the tip its producer had observed is declined, so the revert that could not be undone is avoided as well as refused. It returns a `BootstrapOutcome` rather than throwing when nothing is usable: indexing from the start block is the correct answer to "no snapshot is available".
  - `openAndBootstrap(store, locations, options)` -- the boot path, which keeps the SAFE order the short one: open snapshot-aware first, then bootstrap only if the store has never synced.
  - `createSnapshot(...)` -- the MINIMAL producer, and it says so. Publishing snapshots as a first-class artifact (a publish command, format versioning, mirror layout, pruning old ones) is a design of its own.

  **`@etherfold/browser`** gains no API and one piece of documentation that matters: `createBrowserStateStore` now says how a browser deployment bootstraps, and that the store must be opened through `openSnapshotAware` on EVERY boot rather than only on the boot that installs a snapshot. The mechanism deliberately does not live here -- deciding whether local is already ahead means reading `lastToBlock` out of a stored cursor, and the cursor's codec belongs to the entity runtime (ADR-0027), which this package does not depend on so that it stays free of any one processor package.

  **`@etherfold/state-store-conformance`** gains a `bootstrapping from a snapshot` group, so every backend inherits the obligation rather than rediscovering the trap in somebody's browser tab: rows and cursor installing as one unit, the origin surviving a fresh handle over the same storage, the revert refusal, the wipe still working, and -- selected on what the backend claims -- the floor being refused below and answered at and above.

- ce8f7d2: A handler can now ask about a SET of rows: the bounded id-prefix listing.

  ```ts
  // entity: {name: 'placement', id: ['epoch', 'position', 'playerIndex'], fields: {player: 'text'}}
  const {rows, truncated} = await state.list('placement', {epoch: 7}, 8);
  ```

  That is the one read the entity model was missing, and it is what makes a one-to-many expressible the way a subgraph's `@derivedFrom` does it: children are their own entity keyed by their parent, and the collection is DERIVED WHEN READ. Nothing is maintained at write time. `MutationContext` gains `list`; `StateStore` gains `listCurrent` and `listAsOf`, which every backend must implement.

  **The bound is the decision, not an implementation detail.** A listing takes a PREFIX of the declared id (a leading run of its id columns, at least one) plus a REQUIRED limit, and takes no `where`, no `orderBy` and no offset. A handler runs once per event on every backend, including the ones with no query planner, so the seam gets the one shape that is an indexed range scan everywhere: a key-prefix range with a bound. An accidental full scan is therefore impossible to EXPRESS rather than merely discouraged. `@etherfold/state-store-sqlite`'s `queryCurrent` / `queryAsOf`, which do take caller-supplied SQL, are the server-side read layer and are unchanged. See `docs/adr/0021`.
  - **Truncation is reported, never inferred.** A listing answers `{rows, truncated}`, and every backend reads one row more than the limit to fill it in, because `rows.length === limit` cannot tell an exact answer from a cut-off one and a cascade delete that guesses wrong leaves orphans silently.
  - **Order is the id's own, ascending**, which is what a range scan gives for free, and therefore LEXICOGRAPHIC over the stringified id: `'10'` sorts before `'9'`. Key ordered children by something naturally unique and ordered (an event ordinal, or `(blockNumber, logIndex)`) and make a numeric key fixed-width. If arrival order is wanted, that is a modelling answer, not a parameter.
  - **Read-your-writes holds for a listing too**: a child written earlier in the block appears and one deleted earlier in the block does not, which means merging the block's staging area into the scan rather than falling through to the store. The fetch budget accounts for staged deletes, so a limit is still filled from beyond them.
  - **In SQLite it is one indexed range scan**: equality on the leading id columns plus `ORDER BY` the declared id rides the entity's id index with no sort and no table scan. Pinned by the generated statement's shape AND by `EXPLAIN QUERY PLAN`, since no behavioural assertion can tell a range scan from a table scan that returns the same rows.
  - **The conformance suite gained a group for it**, so a new backend is held to the same answers, and `@etherfold/processor-entities` gained a test that models the real ordered bounded collection from `work/notes/findings/sqlite-in-the-browser.md` (a window of seven, evicting the oldest and everything nested under it) with no stored array, no CSV index and no count, on both backends.

- b61de79: A declaration is now legal on every backend or refused on every backend, and the rest of the "same declaration, different meaning" class is closed.

  `entity-identifier-sql-keyword` fixed the SQL-KEYWORD half by quoting in `@etherfold/state-store-sqlite`, deliberately keeping one engine's reserved-word list out of the shared seam. This finishes the audit it opened. **It contains source-compatibility breaks** (named below); breaking an existing declaration was accepted where the rule is right.

  **Two names that differ only in CASE are now refused at declaration time, on every backend** (`@etherfold/state-store`, **breaking**). `{name: 'token'}` and `{name: 'Token'}` were accepted (`normalizeEntities` de-duplicated by exact string) and then meant two different things: SQLite folds identifier case even inside quotes, so `CREATE TABLE IF NOT EXISTS "Token"` matched the existing `token` and was silently SKIPPED, leaving ONE table with `token`'s columns and `getCurrent('Token', ...)` answering with `token`'s row, while the memory, patch and IndexedDB backends kept two entities. Quoting cannot reach this one, and no spelling of the DDL makes the engines agree, so the answer had to be the declaration's: two names a backend could confuse are one name.

  Unlike a keyword list, this belongs at the seam, and the distinction is written out where the rule lives (`src/entities.ts`): a keyword list is one engine's VOCABULARY, which quoting removes entirely; case is IDENTITY, and the backends disagree about it, so it is a PORTABILITY rule. The rule applies at all three levels -- entity names, id columns and fields -- with id columns and fields treated as one namespace, since they are the columns of one row. The message names both spellings and says to rename one. A repeated id column (`id: ['id', 'id']`, previously accepted here and `duplicate column name` at `migrate()` on SQLite) is refused too.

  **An entity named like another entity's derived index no longer breaks `migrate()`** (`@etherfold/state-store-sqlite`, **breaking for a stored database, not for a declaration**). An index and a table share ONE namespace in SQLite, so declaring `token` beside `token_open` was two ordinary entities everywhere else and `SQLITE_ERROR: there is already an index named token_open` here. The derived index names now carry the store's `_` prefix (`_token_open`, `_token_history`, `_token_lower`, `_token_upper`), which the seam already keeps declarations out of, so the collision is impossible by construction rather than refused by a new rule -- a declaration's legality must not depend on which other entities were declared beside it. An existing database re-migrates cleanly and keeps its old, now-redundant indexes under their old names; drop them by hand or rebuild.

  **An entity name in SQLite's own `sqlite_` namespace is refused when the store is CONSTRUCTED** (`@etherfold/state-store-sqlite`, **breaking**), rather than at `migrate()`. SQLite refuses `sqlite_`-prefixed object names however they are quoted, so this is genuinely one engine's limit and does not become a seam rule; what it does become is a DECLARATION-time failure, where the store was built, instead of a deploy-time one. `sqlite_`-prefixed COLUMN names stay legal, because SQLite allows them and narrowing the seam for no engine reason is the same defect pointing the other way.

  **Audited and left alone.** Identifier LENGTH: no backend imposes one (SQLite stores a 2,000-character table name and its indexes; the others hold names as JS strings), so the seam invents none. NON-ASCII and NFC/NFD collisions: already unreachable, because the shape rule `/^[A-Za-z][A-Za-z0-9_]*$/` is ASCII-only, so `café` and `cafe` + U+0301 are both refused as identifiers and can never become the case collision in another alphabet. That is also why the case fold is exact rather than approximate, and the regex now says so.

  **`@etherfold/state-store-conformance` carries every new rule**, so a future backend inherits the obligation instead of rediscovering it. The `a declaration means the same thing on every backend` group gains the case cases (entity, id column, field, and across the id/field boundary), the non-ASCII case, and `DECLARATION_PROBES`: an exported list of legally-shaped names that strain some engine (`sqlite_` entity and column names, a 200-character entity name and column names, and an entity named like a derived index), each asserting only that the store REFUSES when it is constructed or stores and reads the row back -- never accepted-then-fatal-at-`migrate()`. Adding a probe is how a newly found engine limit becomes every backend's problem at once.

  The `_` prefix rule, the shape rule and `entity-identifier-sql-keyword`'s quoting are unchanged and still tested.

- 2a4e6ed: An entity column named after a SQL keyword no longer works on some backends and kills `migrate()` on others.

  **The defect.** `{name: 'placementPlayer', id: ['epoch', 'position', 'index'], ...}` passed identifier validation (`index` matches the shape rule and does not touch the store's `_` namespace), was stored and read without complaint by `MemoryStateStore`, `@etherfold/state-store-patch` and `@etherfold/state-store-indexeddb`, and then died on `@etherfold/state-store-sqlite` at `store.migrate()` with `SQLITE_ERROR: near "index": syntax error`. SQL cannot bind an identifier as a parameter, so a name reaches the engine as TEXT, and a SQL KEYWORD has a perfectly ordinary identifier shape: `index`, `order`, `group`, `select`, `table`, `where`, `default`, `references` and `primary` were all in the same position. The declaration is the surface ONE processor writes and SEVERAL backends store, so this made a processor silently non-portable and failed at deploy time on one platform, far from where the name was written.

  **The fix is to QUOTE, not to reject.** `@etherfold/state-store-sqlite` now emits every identifier that came from a declaration double-quoted -- the entity name, its id columns, its fields, and the index names derived from the entity name -- in its DDL (`src/ddl.ts`), in its statement builders (`src/statements.ts`) and in the reads on the store itself. **This is not a compatibility break:** every declaration that was legal before is still legal, and the ones that used to be fatal on SQLite now work. Rejecting keywords at declaration time was the other defensible fix and was not taken: it would have pushed one engine's reserved-word list into the surface every backend shares, broken declarations that are legal today, and re-opened the same hole the day SQLite adds a keyword or a second SQL backend arrives with a different list. The store's own fixed names (`_lower`, `_upper`, `_rowid`, `_blocks`) stay bare, so "quoted" reads as "this name came from outside".

  The shape rule is unchanged and still does its job: `to"ken`, `a-b` and anything else that is not `/^[A-Za-z][A-Za-z0-9_]*$/` is refused at declaration time, on every backend, and the `_` prefix stays the store's own. Quoting is not what stands between a declaration and injection; the shape check still runs first.

  **`@etherfold/state-store-conformance` gains a group, `a declaration means the same thing on every backend`**, asked of every backend. That is the property this was a defect against rather than a naming preference: a declaration one backend accepts must work on all of them, and one any backend refuses must be refused by all of them, at DECLARATION time. Its subject is a new shared fixture, `RESERVED` -- an entity named `order` with id columns `group` and `index` and fields `select`, `table`, `where`, `default`, `references` and `primary`. It is in `CONFORMANCE_ENTITIES`, so every case migrates it, every revert sweeps it and every prune considers it, and the keyword identifiers reach every statement a backend emits rather than only its DDL. A backend that adds this version of the suite and does not quote will see the whole run go red, which is what it did here before the fix.

  `quoted(name)` and `quotedList(names)` are exported from `@etherfold/state-store-sqlite` for the caller-supplied-SQL tier (`queryCurrent` / `queryAsOf`), where the predicate text is the caller's to write and therefore the caller's to quote: `store.queryCurrent('order', {where: `${quoted('default')} > ?`, args: [7]})`.

- 01ab642: A configured retention window is now ENFORCED against storage, so a store that declares one stops growing.

  **`StateStore.prune(options?)` is the new verb**, on the seam and implemented by both shipped stores. It deletes the versions the declared retention no longer covers and reports what went: `{tip, floor, versionsDeleted, complete}`. Assert on `versionsDeleted`, never on reported bytes: `navigator.storage.estimate()` is quantised and lags badly enough that the spike measured it reporting MORE space used after a prune that dropped nothing.

  **It is a call the HOST schedules, and that is a decision rather than an omission (ADR-0022).** A prune plus `VACUUM` measured 1.1 seconds at 62,553 versions while a block on the same real stream carries a median of 7 mutations, so folding it into `applyBlock` would stall whichever block happened to cross a threshold, for work that block did not cause, and would have a store picking a maintenance cadence for a browser tab, a backfilling CLI and a long-running server alike. An amortised policy is `prune({maxVersions: n})` on your own schedule (watch `complete`); a background policy is `prune()` on a timer. Pruning a store with nothing to enforce (`unbounded`, or `revert-only` with no declared `finalityDepth`) is a NO-OP and not an error, so a host may schedule it unconditionally. `VersionedStateEventProcessor.prune()` is the same call for a deployment that configured retention through the processor; it is on the processor and not on the read-only `state` view, because it is a write.

  **The LIVE version of an entity is never dropped, however old it is.** A row written once at block 12,082,307 and never touched again is still the current state, and on the real measured stream (event-bearing blocks median 429 apart, rows written once and never revisited) that is the normal case rather than an edge. The floor is `retentionFloor`, which is exactly `retainedRange(...).from`, so the block a read is refused below and the block a version is deleted at cannot drift apart, and `revertTo` still reaches the full depth of the window afterwards.

  **A store with a window configured now REPORTS that window** instead of downgrading to `unbounded`, on `@etherfold/state-store-sqlite` and on `MemoryStateStore` alike, because both now enforce it on both halves: refused on every as-of read, and dropped from storage by `prune`. `retentionWithoutPruning` is REMOVED (it existed only to express "this store cannot enforce what it was asked"). The report remains about what a caller may RELY on rather than about bytes on disk, so a host that has not pruned yet still refuses the reads its window excludes -- the safe direction, and the same one a `revert-only` store already took.

  **`BatchBounds` gains `maxRowsPerStatement` (default 500).** The existing bounds cap a batch and say nothing about a single statement touching an unbounded number of rows, which is exactly the shape a hosted backend rejects, so a prune deletes by an explicit bounded list of row ids instead of by predicate. That also makes the count exact, which `remote-sql` (rows, no affected-row count) could not otherwise supply.

  `@etherfold/state-store-conformance` gains a `pruning, and what must survive it` group, asked of every backend under each retention claim, and its windowed subjects are now ordinary configuration rather than test doubles.

- ebf9690: One conformance suite every state-store backend must pass, including its capability claims.

  **A new package, `@etherfold/state-store-conformance`.** Adding a backend is providing a factory and running one suite:

  ```ts
  await describeStateStoreConformance('MyStore', (declarations) => new MyStore(declarations));
  ```

  It asserts EXTERNAL BEHAVIOUR only -- what a read returns after a write, after a revert, as of a block -- and never a table, a statement or a version column, so a versioned-rows backend and a patch-log backend can both be asked it. Five groups: versioned reads (a version is a COMPLETE row with a half-open validity range), as-of reads tested against what the store CLAIMS, reorg revert including a counter that must go back DOWN, read-your-writes within a block, and a block applying as one atomic unit.

  **The capability report is read first, and then tested.** A store claiming `unbounded` is asked a read at any depth; a store claiming a WINDOW is asked at both of its edges and must refuse below it with a `BlockNotRetainedError` naming what was asked and what is kept; a store that answers no historical read must refuse every one of them. Testing a backend against a capability it never claimed would fail honest backends, and testing it against less than it claimed is what lets a claim become fiction.

  **That the capability cases are real is itself a test.** The suite is run against backends carrying one lie each -- claiming a window it does not honour, answering an as-of read from the tip, accepting a revert without undoing the state -- and the tests assert which cases go red. This is why the cases are exported as DATA (`stateStoreConformanceCases`, `runStateStoreConformance`) with the vitest registration as a thin adapter on top: a suite that only registers tests can be run but cannot be asserted on. See ADR-0020.

  **The reorg case is the load-bearing one and runs on every backend**, not once: an accumulated counter that does not decrease when its block is reverted is the canonical bug this design exists to make impossible, and the real instance is recorded in `work/notes/findings/sqlite-in-the-browser.md` (a `computedPoints` of 12 going back to 6). The counter is accumulated through the mutation context, because the read is where the bug bites.

  The suite runs today against `MemoryStateStore` and against `@etherfold/state-store-sqlite`'s `VersionedStateStore` on a real libSQL database, each under three retention claims. Shared cases that existed as a second copy in `state-store-sqlite` and `state-store` have moved into it; what stays in those packages is what only that implementation can be asked.

- 5854d60: **The storage seam gains a sync-cursor port, and `applyBlock` can write the cursor with the block** (ADR-0027).

  `StateStore` gains `readCursor(key)` / `writeCursor(key, value)` / `clearCursor(key)` over an **opaque string**, and `applyBlock(block, mutations, cursor?)` takes an optional `{key, value}` that is written in the SAME transaction as the block. This reverses an explicit "deliberately absent" on the interface: a cursor that could only be a SQL table stopped one-processor-several-backends at the first deployment that was not SQLite, and only the store holds the transaction the block write happens in, so only the store can stop a crash from leaving state ahead of the cursor.

  It stays a STRING and never a typed `LastSync`: that is a `@etherfold/core` type, and typing the port with it would make this package depend on core, invert ADR-0016 and drag viem into every storage primitive. `@etherfold/state-store` still declares no dependencies at all.

  Per backend:
  - **`@etherfold/state-store-sqlite`**: a new fixed `_cursor (key, value)` table, created by `migrate()` alongside `_blocks`, and the cursor statement rides in the same `batch([...])` as the block. `CURSOR_TABLE`, `readCursorStatement`, `writeCursorStatement` and `clearCursorStatement` are exported like the rest of the SQL.
  - **`@etherfold/state-store-indexeddb`**: a new `cursors` object store, written inside the block's own transaction. The package's schema version moved from 1 to 2; the upgrade is additive and `contains`-guarded, so an existing database gains the store and keeps every row. A processor declaring another entity is still not a migration.
  - **`@etherfold/state-store-patch`**: an in-memory map, written after the point where anything can still refuse. Its `durability: 'memory-only'` already says what that means for the cursor: it goes with the process, exactly as the state does.
  - **`MemoryStateStore`**: the same, as the executable definition.

  `@etherfold/state-store-conformance` gains a `the sync cursor` group: the round trip, the clear, the opacity of the value, and the one that matters — a store never reports a cursor ahead of its last applied block, asserted through a refused block and through a re-applied height. The suite's own tests gain a backend that writes the cursor before the block, so the new group is proven to catch it.

  A cursor is deliberately NOT reverted by `revertTo` and not touched by `prune`: how far the caller got is not entity state.

### Patch Changes

- e1261b1: Point at the heavy conformance workload, now that it exists.

  The suite's own declarations stay small and hand-written, and the README and the `CONFORMANCE_ENTITIES` doc comment said the captured stratagems stream was a future task. It has landed as `@etherfold/conformance-workload-stratagems` (private, unpublished, because the vendored oracle it is derived from is GPL-3.0): 31,332 real logs from the LAUNCHED stratagems game on Base, replayed through the ported processor on every backend and compared against the state that game's ORIGINAL `JSProcessor` computed from the same bytes, including the revert that makes an accumulated `computedPoints` go back down from 12 to 6.

  Documentation only. No behaviour, no exports and no types changed here.

- Updated dependencies [ff393f7]
- Updated dependencies [4e75014]
- Updated dependencies [ce8f7d2]
- Updated dependencies [b61de79]
- Updated dependencies [2a4e6ed]
- Updated dependencies [879c4fe]
- Updated dependencies [01ab642]
- Updated dependencies [18c6876]
- Updated dependencies [ab45129]
- Updated dependencies [ebf9690]
- Updated dependencies [5854d60]
  - @etherfold/state-store@0.1.0
