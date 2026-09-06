---
'@etherfold/core': patch
---

Decoding a log is 3.2x faster: `LogEventFetcher` preselects the ABI event by `topic0` instead of letting viem re-search the whole ABI on every log.

`decodeOnto` handed `decodeEventLog` every event member declared at the log's address, once per log, and viem then found the member the log names by re-deriving each candidate's event selector — a keccak per candidate, per call, memoised by nothing. Over a replay that search, and not the decoding, was where most of the decode time went.

The fetcher now builds a `${address}:${topic0}` map ONCE, from the same de-duplicated per-address lists it already decodes against, and a hit passes a one-member ABI. Measured through the shipped path over the 31,330 real Base logs of `docs/spikes/replay-decode-cache/decode-breakdown.ts`: **58.2 µs/event before, 18.4 µs/event after, for a map that costs 0.24 ms to build** (`work/notes/findings/decoding-is-3x-faster-with-a-memoised-topic0-map.md`).

**No published surface moves.** The map and the lookup are private, `reparse` and `parse` return exactly what they returned, and the same 31,330 logs are asserted to decode identically both ways. It is a memoised lookup and not a cache of a derivation: nothing is stored, and the map is rebuilt from the source whenever a fetcher is constructed.

Two inputs deliberately keep the whole-ABI route, with a fallback rather than a refusal, so nothing can reach a path that did not exist before: an ANONYMOUS event, which carries no `topic0` to be keyed by, and a log naming an event the address does not declare. `parseAllEventsIrrespectiveOfAddresses` keeps its existing route too and grows no map of its own, because ADR-0031 is that it decides which ABI decodes a log and must never decide which events exist.
