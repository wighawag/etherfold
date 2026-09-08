---
'@etherfold/core': minor
---

A provider's refusal of an oversized `eth_getLogs` is now read from its STRUCTURED data before its prose, and `-32000` is read at all.

`getNewToBlockFromError` decides how far a refused range shrinks before the retry. It read the error's MESSAGE with a regex and never looked at `error.data`, even where the provider had put the answer there. Three additive changes, none of which touches the halving fallback:

**`error.data` is read first.** Infura sends `{"code":-32005,"data":{"from":"0xBDE5F8","limit":10000,"to":"0x102DBCC"},"message":"query returned more than 10000 results. Try with this block range [0xBDE5F8, 0x102DBCC]."}` — the same instruction twice, once as a descriptor and once as English, and only the English was being read. `data.to` is now taken when `data` carries a `to` and a `limit`, and `limit` is required rather than decorative: it is the node's own cap, so an object carrying it is describing a REFUSAL, while an object with a bare `to` may be a provider echoing the request back, and reading that would hand the retry the very range that was just refused.

`data` is also read when it is PROSE. Nethermind puts the entire hint there and leaves the message at a bare `"invalid params"` (`{"code":-32602,"message":"invalid params","data":"Query returned more than 50000 results. Try with this block range [0x1000000, 0x1080000]."}`, Gnosis and Fraxtal, captured 2026-09-08), so a reader that only looked at the message discarded a complete, machine-readable answer and halved blindly against a node that had already said what to ask for.

**`-32000` is accepted under the same hint gate as `-32602`.** It is a widely used generic server-error code and providers do put range complaints behind it: Polygon zkEVM, PulseChain, Merlin and Immutable all state one there. Before this the code alone discarded them.

**The `looksLikeRangeHint` gate stays, and is now pinned by tests.** It looks like a redundant guard beside two specific error codes and it is not: `-32602` and `-32000` are GENERIC, so a refusal under one may be about anything at all. `ethereum-rpc.publicnode.com` refuses history with `-32602 "Archive requests require a personal token..."`, and Cronos refuses a wide range with `-32000 "maximum [from, to] blocks distance: 2000"` — a bracketed pair that is a parameter-name list, not blocks. Without the gate a bracketed pair from an unrelated complaint becomes a `toBlock` the fetcher then retries against, for a refusal no range size can ever satisfy. Widening the accepted CODES was deliberately not a licence to widen the two markers, and each piece of text is gated ON ITS OWN, so a hint in `data` never licenses lifting a pair out of the message.

Every parse path is now tested against a response a real provider really sent, with the endpoint named beside it, re-captured live across 60+ keyless public endpoints on 2026-09-08; the probe script and the raw output are in `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`. Two things that re-run turned up: `rpc.mevblocker.io` no longer sends the structured shape the original capture came from (it enforces a block-span cap now), and no reachable `-32000` carries a machine-readable suggestion today, so the widened code changes no answer yet and only stops the hint being thrown away on its code.

**Nothing here makes an unknown endpoint worse.** A provider that says nothing useful still halves, which is what makes the fetcher work against an endpoint whose cap nobody knows, and that path is asserted end to end rather than assumed.
