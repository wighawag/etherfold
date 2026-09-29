---
'@etherfold/platform-nodejs': patch
---

A `startServer` whose bind fails (for example `EADDRINUSE`) now closes the database it opened itself from a libSQL URL (`options.db` as a string, `env.DB`, or the `file:./etherfold.db` default) before rejecting with the bind error. A `RemoteSQL` handle the caller passed is still never closed: it stays open and usable.
