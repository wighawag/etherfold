---
title: 'Uploading (or re-reading) the predecessor bytes folds the predecessor while it stays in the predecessor slot'
slug: an-upload-of-the-predecessor-folds-it-without-promoting-it
observed: 2026-09-26
---

2026-09-26, seen by the conductor at Gate 3 on `a-processor-bundle-is-uploaded-to-a-running-node`. Sending the bytes of the generation `predecessor` names answers `registered`, and the registry resolves the identity to the record it already has, which STAYS in `predecessor` (a slot already naming it is not re-armed) while this process now holds a fold for it (`folding: held`). The test pins that as today's behaviour for both arrivals (`packages/cli/test/aBundleIsUploadedToARunningNode.test.ts`, "uploading the bytes of the `predecessor` behaves exactly as a re-read of that identity"). So a "rollback by upload" does not roll back (nothing puts it in `successor` or moves the pointer) and leaves an engine running for a generation nobody reads, which is what ADR-0092 says a predecessor should not have. It predates the upload: the re-read does the same. Whether a re-arrival of the predecessor should re-arm it as `successor`, answer `unchanged`, or stay as is, is undecided.
