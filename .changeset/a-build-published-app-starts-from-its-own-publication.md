---
'etherfold': patch
---

An app built and published with the CLI starts from its own publication, asserted end to end (ADR-0095, now implemented).

`etherfold build --publish` folds a fixture chain whose contracts come from a `--deployments` folder, and a browser tab running the same bundle file (`processorBundle`) starts from the publication index (`publication`). The test asserts the tab's source and finality hash to the publisher's stream, that the tab lands on the state of a tab that indexed the chain itself, absorbs a reorg inside the finality window, and downloads only the index and a snapshot body that does not grow with the stream. It also covers `--seed` (a processor-only change re-folds the published stream locally), `--history` (a revert inside the published history, refused under its floor) and an old build that keeps starting from its own entry after a new processor is published. No runtime change: the CLI gains `@etherfold/browser` and `fake-indexeddb` as dev dependencies for the test.
