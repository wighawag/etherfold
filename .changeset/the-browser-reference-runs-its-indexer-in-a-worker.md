---
'@etherfold/browser': patch
---

Documentation only: the README no longer calls `examples/browser-reference` the worked version of `updateProcessor` and `updateIndexer`. The reference now indexes in a dedicated worker (`hostIndexerInThisWorker` in its worker entry, `connectToIndexerHost` in the tab, with the wallet's provider handed over as a port and the source sent as settings), so it shows the port's counterparts: a redeploy is `reconfigure({source})`, which folds a new generation beside the live one, and an edited processor reloads the worker.
