---
'@etherfold/state-store-sqlite': patch
'@etherfold/state-store-patch': patch
'@etherfold/state-store-indexeddb': patch
'@etherfold/server': patch
---

**Five source-scanning gates now match CODE rather than the whole file, so documenting a rule no longer breaks the gate that enforces it.**

Tests only; no shipped behaviour changes. These packages assert platform-neutrality by scanning `src/` for a forbidden word -- no `D1`, no `cloudflare`, no `console.`, no `D1Database`, and, in `@etherfold/state-store-patch`, that the as-of methods never reach for stored state. Run against raw file text they read PROSE as well as code, so the sentence explaining *why* a store must never name D1 failed the gate that exists to keep it from naming D1. The perverse incentive is the point: the cheapest way back to green was to delete the explanation, so the check punished exactly the comment that would stop someone reintroducing the dependency.

A shared `codeOnly()` helper strips comment trivia with the TypeScript scanner before matching. String literals are deliberately KEPT, because `'D1Database'` in a string is a real reference and a gate that ignored it could be defeated by quoting. The anchored `^\s*import ... from '...'` scans keep reading raw source, since an import cannot be a comment; only the whole-file word matchers changed. `state-store-patch`'s method-body slice still finds its boundaries in the raw text, so `\n\t}` keeps meaning "closing brace at class indent" -- only the matched text is stripped.

Verified in both directions rather than assumed: a comment mentioning D1 and cloudflare now passes, while a bare `D1` token in code and a `@cloudflare/workers-types` import both still redden the gate.
