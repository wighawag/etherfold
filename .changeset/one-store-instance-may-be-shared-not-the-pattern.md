---
'@etherfold/state-store': patch
'@etherfold/state-store-conformance': patch
---

Docs only: `openForWriting`'s JSDoc, the conformance case and both READMEs no longer call `createState: () => store` (one store instance handed to every generation) "the shipped generation pattern". Sharing one instance is legal, and is why a claim is idempotent per instance; generations that fold side by side need their own storage (a namespace or a database each), which is what the shipped hosts do.
