---
'@etherfold/platform-nodejs': patch
---

A `startServer` that fails anywhere between opening its database and a successful bind (the automatic schema setup as well as the bind itself) now closes the database it opened itself from a libSQL URL before rejecting with the original error. A `RemoteSQL` handle the caller passed is still never closed.
