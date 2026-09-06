---
'@etherfold/core': patch
---

A decode failure now records the REAL error instead of one constant string.

`LogEventFetcher.decodeOnto` assigned `decoding error: <the actual error>` in its catch and then fell through to a block whose `else` overwrote it with `parsing did not return any results`, because `parsed` is null on exactly the path that had just set the message. The informative branch was therefore unreachable in the OUTPUT, and every failure — a `topic0` the ABI does not declare, data that does not fit the member its `topic0` names, a log carrying no topics at all — recorded the same uninformative sentence. Those are three different faults with three different fixes, and `decodeError` is STORED on the event (`LogEventWithParsingFailure`), so that sentence is what an operator reads back off a stream long afterwards.

The catch now RETURNS, so the real error survives. What is stored is the error's FIRST LINE, which is `<ErrorName>: <what went wrong>`: a stringified viem error runs to several lines carrying a docs URL and `Version: viem@x.y.z`, and persisting that would put a dependency's version number into stored data and churn it on every bump. So a failure reads `decoding error: AbiEventSignatureNotFoundError: Encoded event signature "0x..." not found on ABI.` rather than `parsing did not return any results`.

The `parsing did not return any results` branch is kept for a decoder that returns something falsy without throwing, which viem does not do today.

No API changes: `decodeError` is still a string on the same type, and `apply.ts` — the only reader in the tree — tests for its presence rather than its value.
