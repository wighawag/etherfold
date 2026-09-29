---
'@etherfold/graphql': patch
---

The optional peer on `@etherfold/browser` is declared `workspace:^` instead of `workspace:*`, so the published manifest carries a caret range (for example `^0.12.0`) rather than an exact pin (`0.12.0`), and a consumer who takes a later `@etherfold/browser` patch is not told its peer is wrong. No change to the code.
