---
'@etherfold/processor-entities': minor
---

New `stateFactoriesFrom({open, entities?, finalityDepth?, fetch?, onBootstrap?})`: ONE store constructor, from which both factories of a tab election (ADR-0097) are derived, spread into the spec beside `tabElection: {name}`. `createState` opens the store, starts it from the `published` snapshot the host hands it (`openAndBootstrap`, forwarding `replaceLocal`), and claims it with `openForWriting`, handing the claim signal to the claim alone; `openState` opens the same store snapshot-aware and then with `openForReading`, with its `EntityStateView`, so a reader is read-only by type, never downloads a snapshot, and keeps an installed snapshot's floor. With a published bundle the store is declared from the bundle's own `processor.entities`. The parameter types are structural, so this package still does not depend on `@etherfold/browser`.
