---
title: 'A spike README links out of the site with a relative path, so `pnpm docs:build` fails on a dead link'
slug: a-spike-readme-dead-link-breaks-the-vitepress-build
observed: 2026-09-07
source: 'noticed while running `pnpm docs:build` to check the guide links added by `the-snapshot-only-mode-is-documented-with-its-trade`'
---

`docs/spikes/measure-what-a-published-stream-costs-to-install-and-pick-its-shape/README.md:3` links the finding as `../../../work/notes/findings/what-a-published-stream-seed-costs-to-install.md`. `work/` is outside the VitePress root, so the target is not a page and the build stops: `Found dead link ./../../../work/notes/findings/what-a-published-stream-seed-costs-to-install`, then `[vitepress] 1 dead link(s) found` and a non-zero exit. Pre-existing, landed with `00805ae`; nothing in the acceptance gate runs `docs:build`, so it is invisible until someone builds the site (and the deploy workflow is separately broken, see `the-docs-site-has-not-deployed-since-the-web-demo-was-deleted.md`).

Every other spike README links `work/` notes as absolute `https://github.com/wighawag/etherfold/blob/main/...` URLs, which is why they do not trip it, so the fix is probably to make this one match rather than to widen `ignoreDeadLinks`.
