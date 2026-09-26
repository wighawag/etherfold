---
title: 'A `node` over a `run` database reports its frozen canonical generation in revert words, naming a stream it does not fetch'
slug: a-node-over-a-run-database-reports-a-frozen-generation-as-a-revert
observed: 2026-09-26
---

2026-09-26, seen while building `node-is-a-command-that-receives-uploads` (`packages/cli/test/oneDatabaseIsOpenedByEitherCommand.test.ts`, the frozen case). An `etherfold node` opened over a database a `run` wrote with `INDEXING_SOURCE` naming a contract the bundle does not carry reports the canonical generation `frozen` with reason `stream-not-fetched`, as ADR-0094 says, but the message (from `@etherfold/core`'s container) reads "its stream X is not one this deployment fetches (it fetches Y), so its code was loaded and nothing folds it: a revert across a filter change is a freeze". No revert happened, and the node fetches nothing at all (it is waiting): Y is the stream the stored bundle's own contracts digest to. The reason code is right; the words describe a different situation and may mislead an operator.
