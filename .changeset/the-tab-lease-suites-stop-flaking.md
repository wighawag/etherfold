---
'@etherfold/browser': patch
---

Tests only, no change to the published code: the tab-lease suites stop racing the takeover. The FROZEN-leader case (node) now waits for the new leader's container (`canonical`) before advancing it, since ADR-0097 D4 announces the seat before the fresh start opens the container and `indexMore()` answers as a reader until then (diagnosed in `docs/spikes/the-frozen-leader-takeover-flake/`). The real-browser killed-worker and main-thread close cases poll until the tab that took over has reported its first fetched range before reading `ranges[0]`.
