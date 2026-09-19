---
'@etherfold/browser': minor
'@etherfold/core': minor
'@etherfold/server': patch
---

**A hot update reconfigures the tab it is running in, so editing a handler keeps the warm fold instead of costing a page reload** (ADR-0085).

A developer indexing in a browser tab edits a handler, their bundler hot-replaces the module, and the indexer goes on folding with the OLD one because nothing connects the two. The remedy was reloading the page, which throws away a warm fold and re-indexes from scratch. `reconfigureFromHotUpdate(indexer, {createState, createProcessor})` (`@etherfold/browser`) is the third ARRIVAL: it registers the handed-over processor as a SUCCESSOR beside the live generation, which keeps its own state and goes on answering every read while the new fold catches up.

It needs none of the machinery the server arrivals need, and that is the point. The bundler has already done the module replacement, so there are no bytes to send, no URL to instantiate, no cache to defeat, no route and no credential -- and no authorisation question at all, because there is no remote caller. The tab reconfigures itself with what its own dev server just gave it.

**Nothing here subscribes to anything.** `@etherfold/browser` contains no reference to `import.meta.hot` or to any other bundler HMR global: noticing a change is the APPLICATION's job, which is the same rule the server side already follows (whatever watches a file stays outside the process; the endpoint only re-reads). The bundler is the watcher and it already exists. So a deployment built without an HMR-capable bundler is unaffected BY CONSTRUCTION rather than by a guard, and because this is a free FUNCTION rather than a method on the hook, the production build that eliminates an app's own `if (import.meta.hot)` block drops the arrival with it. Both halves are asserted over a real bundle rather than promised.

**Three outcomes, in ONE shape across the arrivals.** `ReconfigureReport` MOVES from `@etherfold/server` to `@etherfold/core` and is re-exported from both `@etherfold/server` (unchanged for every existing caller, including the admin route's JSON body) and `@etherfold/browser`. It lives in core because the arrivals are in different packages and core is the only one all of them already depend on; two three-arm unions would agree on the day they were written and drift one edit at a time afterwards, which is the claim the type exists to make false.

- `registered` names the generation now folding beside the live one;
- `unchanged` is a SUCCESS and says so plainly. It is now RARE and TRUE, because a module arrival is named by a derivation over its HANDLER SOURCES (ADR-0086) rather than by a version an author declared -- so a real edit always moves it, and `unchanged` means the sources are the ones already running. The message names the one case that can still surprise a developer (a change the handler TEXT does not carry: an imported helper, an entity declaration, a captured value) and names the way out;
- `failed` carries the reason and leaves the tab EXACTLY as it was -- same generations, same canonical pointer, still folding, still answering. That is a property of the ORDER rather than of a rollback: the state, the processor and its identity are all built before a registry record is written or anything is displaced, exactly as the server arrival fails before registering rather than unwinding afterwards. A processor that throws is the ORDINARY case in an editing loop, so it is data rather than an exception, and the next save repairs it.

**A burst stays bounded with nothing to do on the caller's side**: the `successor` slot holds at most one, so a newer save REPLACES the pending one and the count never climbs towards the browser's cap of two (ADR-0084). Five saves leave the incumbent plus one, and the incumbent answers complete reads throughout.

There is deliberately no `{force}` on this call, and there cannot be: forcing means registering a generation BESIDE one of the same name, and the name is what a generation IS. `updateProcessor(next, {force: true})` remains the in-place verb for a fold that changed in a way the source text does not carry, and it costs the rebuild this call exists to avoid.

`@etherfold/server` is otherwise untouched: `ReconfigureReport` keeps its name, its place in the package's exports and its meaning, and only its declaration moved.
