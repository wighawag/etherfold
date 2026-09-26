---
title: 'The committed `nfts` bundle pair no longer rebuilds byte-for-byte from its sources'
slug: the-committed-nfts-bundles-no-longer-rebuild-from-their-sources
observed: 2026-09-26
---

2026-09-26, seen while adding a third bundle beside them (`a-processor-bundle-is-uploaded-to-a-running-node`). `packages/cli/test/fixtures/processor-bundle/nfts.bundle.js` and `nfts-edited.bundle.js` still carry `version:"1.0.0"`, while `source/nfts.ts` and `source/nftsEdited.ts` no longer declare it (removed with the declared version, #170). Rebuilding with the README's command therefore gives different bytes, and the README's "What is in them" paragraph still says the declared `version` is there because the runtimes require it. No test pins a hash, so nothing fails; it is only that the committed artifacts and their stated build input have drifted apart.
