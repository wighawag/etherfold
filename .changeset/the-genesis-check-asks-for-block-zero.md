---
'@etherfold/core': minor
---

The load-time genesis check now asks for block `0x0` instead of the `earliest` tag, and tells its three failures apart.

`earliest` is not genesis. The JSON-RPC tag means the lowest block the CLIENT HAS, which is block 0 only when the client happens to have block 0. A pruned or partially-synced node's lowest block is wherever its history begins, and a chain that has had a REGENESIS has nodes whose earliest block IS the regenesis point, by design, and several L2s have done exactly that. Both answer the tag with a real block whose hash is not the genesis hash, so a source declaring a `genesisHash` refused to start against a perfectly healthy node on the RIGHT chain, and the message said it was connected to a DIFFERENT one. That is a false positive whose wording actively misleads, on the one check whose entire job is to be trustworthy about identity. The check now names the bottom of the CHAIN (`0x0`) rather than the bottom of that node's history, with the reason written at the site so it does not get tidied back.

Fixing the tag alone would have moved the problem rather than removed it, because the check could not tell a wrong chain from a node that would not answer. It now refuses in three named ways, and a caller does something different about each:

- `GenesisHashMismatchError`: the node served block 0 and it is not the declared genesis. The only one of the three that is a claim about WHICH CHAIN the node is on. It carries `expectedGenesisHash` and `receivedGenesisHash`, so the numbers an operator compares against their contracts file are in the error rather than only in an English sentence. `retryable: false`.
- `GenesisBlockNotServedError`: the node answered with no block, which is ordinary on a pruned node and says nothing about the chain. The message is about not being able to CHECK, and names the two remedies (a node that serves block 0, or `skipGenesisCheck`). `retryable: false`, because a node does not acquire history while a caller waits.
- `GenesisCheckUnavailableError`: the request itself failed: a timeout, a rate limit, a dropped connection. Previously nothing caught this at all, so a flaky endpoint at startup propagated out of the load path exactly as a real mismatch did. It carries the underlying `cause` and is `retryable: true`, the position `IngestionUnavailableError` already holds on the ingestion path.

All three are exported from `@etherfold/core` and follow the package's `retryable` convention, so a host reads the flag structurally rather than matching on a message.

Two smaller things ride along. The commented-out per-cycle genesis check, which carried the same `earliest` mistake and would have reintroduced the bug the day anyone uncommented it, is DELETED rather than repaired: reviving a per-cycle genesis read is a decision about cost per cycle, not a line to uncomment, and the one place that asks the question is now `checkGenesisHash`. And the provider-surface guard's genesis probe (`isGenesisProbe`) is narrowed to `0x0` alone: it accepted both spellings only so this fix could land as the small change it is, and `earliest` is no longer a question this engine asks.

`skipGenesisCheck` also gains the docstring it never had, including what turning it off actually costs: a fork answering the right `eth_chainId` is then indexed as the chain it claims to be.
