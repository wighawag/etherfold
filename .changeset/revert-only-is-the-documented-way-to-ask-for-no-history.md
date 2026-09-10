---
'@etherfold/browser': patch
'@etherfold/state-store': patch
---

**Documentation only: `revert-only` is now named, where a browser app chooses retention, as the way to ask for reorg safety with no history.**

The setting already existed and already worked; nothing said so at the point of choice. `BrowserStateStoreConfig.retention` described the window (`{blocks: N}` and the finality depth it may not go under) and mentioned `revert-only` only as a thing that happens to state a prune floor, so a developer who wanted "reorg safety, no history" had no reason not to approximate it with a small window.

That approximation is worse than it looks, and the reason is measured rather than stylistic. Retention counts BLOCK NUMBERS and never updates (ADR-0019), and on the real measured stream event-bearing blocks are median **429 blocks apart**, max 1,226,194 (`work/notes/findings/sqlite-in-the-browser.md`), so `{blocks: 64}` typically holds exactly ONE of them, the tip's, and often none. What that buys is a store that refuses almost every historical read while looking configured for history: the failure is a refusal a session meets late, rather than a fact reported up front.

The configuration docstring now says all three parts: `revert-only` is the way to say it, it reports `capabilities.asOf === false` so a caller that needs history learns at startup rather than from a wrong or refused answer later (which is why `asOf` is reported separately from `retention`: a window answers inside itself and refuses outside it, while a store that reconstructs no history refuses everywhere), and it still guarantees the reorg half, because its floor is the finality depth and the versions a revert reopens are exactly the ones it keeps. `finalityDepth`'s own docstring now says why it belongs beside `revert-only` and not only beside a window. The same paragraph is in `@etherfold/browser`'s README, and the `'revert-only'` and `'unbounded'` arms of `RetentionSetting` (`@etherfold/state-store`) carry per-arm docs, so the choice is described where an editor shows it.

One test is added rather than changed, pinning the claim the docstring now makes on the DEFAULT backend: `createBrowserStateStore(entities, {retention: 'revert-only', finalityDepth: 64})` reports `{retention: {kind: 'revert-only'}, asOf: false}`. It passes on the code as it stands, which is the point: the prose is now checkable.

No behaviour, default or type changed: `unbounded` is still the default, `revert-only` still reports `asOf: false`, and a window is still refused below the finality depth.
