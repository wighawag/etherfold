---
title: "`@etherfold/server`'s README still says the server does not hold generations yet"
slug: server-readme-says-the-server-holds-no-generations
observed: 2026-09-06
source: 'noticed while wiring task:the-cli-and-the-server-hold-generations-the-same-way, reading the README for what `/status` claims'
---

`packages/server/README.md` (the `/status` cursor envelope section) describes the generation dimension as future work -- "the server does not hold them yet, so it reports one cursor and a later host adds a key beside `value`" -- but `StatusReport.generations` is built and reported, and both `etherfold run` and `etherfold index` now fill it with one entry per generation held. The prose predates `a-rebuild-in-progress-is-never-an-empty-answer` landing.
