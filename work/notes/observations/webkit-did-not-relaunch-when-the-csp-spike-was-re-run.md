---
title: 'Playwright WebKit died at `newPage` when the CSP spike was re-run, on the same host and env that had just produced its rows'
slug: webkit-did-not-relaunch-when-the-csp-spike-was-re-run
observed: 2026-09-17
---

2026-09-17 — Noticed while re-running `docs/spikes/a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp` to verify its committed results before landing. Chromium and Firefox reproduced EXACTLY (110 verdicts per engine, zero differing from `results/csp-*.json`), and then WebKit threw `browserContext.newPage: Target page, context or browser has been closed` on its first page, under the same `nix shell nixpkgs#mesa nixpkgs#libglvnd` + surfaceless-EGL recipe the spike's README documents and that had produced `results/csp-webkit.json` minutes earlier.

Not investigated, and it is a HARNESS signal rather than a result one: the two engines that did run agreed with the stored rows verdict-for-verdict, so nothing in the finding is in doubt. But it means the WebKit column of that spike is, on this host, not reliably re-runnable, and anyone re-verifying it should expect to have to fight the launch rather than assume a red run is a changed answer.
