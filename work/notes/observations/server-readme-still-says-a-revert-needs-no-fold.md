---
title: 'The server README still says a revert target is answered with no engine at all'
slug: server-readme-still-says-a-revert-needs-no-fold
observed: 2026-09-26
---

2026-09-26, noticed while building `status-says-when-the-canonical-generation-is-frozen`. `packages/server/README.md` ("Moving the pointer is the whole of promotion...") still says the route "does NOT require the host to hold a FOLD for the target -- ... the generation an operator reverts to answers with no engine at all, which is the ordinary case on a host redeployed with the new processor alone". Since ADR-0092 (ADR-0057's 2026-09-25 amendment) a same-stream target on a Node deployment is instantiated from its stored bundle and folds, and one whose code cannot be built is refused (`409 generation-cannot-fold`). The same claim in `packages/server/src/api/admin.ts`'s header JSDoc was corrected by that task; the README was outside its scope.
