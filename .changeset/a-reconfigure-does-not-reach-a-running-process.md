---
'etherfold': patch
---

Correct a comment that said a reconfigure reaches a running `run`, which it does not.

`driveCycles`' doc opened with "A `run` is a long-running host, **so a reconfigure can reach it**". Read in context that was about having TIME to advance a follower, contrasted with `build`, which "has no reconfigure, holds exactly ONE generation and exits". Read quickly it says a reconfigure arrives at RUNTIME, and it does not: a generation is registered when the container OPENS, from config, so a changed processor or source reaches the process by RESTARTING it. Nothing in the CLI watches a file, and no route adds a generation (the whole admin API is the canonical-pointer move).

It also credited the wrong mechanism. What makes that restart survivable is not the process being long-lived, it is the registry and the state being ROWS: the new process finds the incumbent already there, still canonical, still answering, and registers the successor beside it. The long-running shape buys the other half, somewhere to put the bounded rebuild that carries the successor to level once it exists.

No behaviour changes. This is recorded as a release note rather than a silent edit because the comment is load-bearing documentation about how a reconfigure works, and reading it as "a reconfigure arrives at runtime" is a mistake it has already caused.
