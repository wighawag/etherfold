# The two captured stratagems deployments

> **`base` is NOT "the Base deployment".** Stratagems has TWO deployment folders on Base and both `.chain` files say `chainId: 8453`. `deployments/base/` is an early one that saw **45 logs and was abandoned**; `deployments/alpha1/` is the **LAUNCHED game**. The folder name is the trap, and it has already been walked into once: `work/tasks/done/spike-sqlite-in-the-browser.md` named the `base/` addresses by mistake, which is why the correction is the FIRST section of `work/notes/findings/sqlite-in-the-browser.md`. If a number here does not match one quoted somewhere else, check which deployment that number is about before anything else.

| | `stratagems-base.*` | `stratagems-alpha1.*` |
| --- | --- | --- |
| what it is | the ABANDONED early deployment | the **LAUNCHED game**: the workload |
| stratagems folder | `contracts/deployments/base` | `contracts/deployments/alpha1` |
| chain | Base, 8453 | Base, 8453 |
| Stratagems | `0xb99d938a722df8984722ab38732533130b4f3ec4` @ 11,681,933 | `0x5ab6d5bb8012fc60ab3653e025be4a59b4406ff2` @ 13,499,257 |
| Gems | `0xd1b76de5372bc47fc4b7ad918f11937fc17b7b46` | `0xb2d822732347e3dc60258dcf6cf0d4c7a432b678` |
| GemsGenerator | `0xbe2f7c303b53f16f447fd82bf549e65185bf3477` | `0xb0855eaf94bf7f122af4f444141e83b7408cc7a7` |
| logs captured | 42 events over 9 event-bearing blocks | **31,332 events over 1,042 event-bearing blocks** |
| reward events (`GlobalRewardUpdated` and friends) | absent from the ABI: an earlier contract version | present, and 16,046 of them fired |
| stored as | plain JSON, because it is small enough to read | **gzipped**, 1.05 MB against 33.8 MB |
| what it is FOR | the fast smoke case, and nothing else | the conformance workload |

## What each file is

- **`*.stream.json[.gz]`** — the golden INPUT: a `StreamFixture` (`@etherfold/core`), which is every log the three contracts emitted plus the `IndexingSource` they were captured for and the `LastSync` at the end of the capture. Its own `provenance` block carries the capture date, the chain head at capture, the block range and `omittedFields`; read it out of the file rather than trusting this table. Replay it with `loadStreamFixture` (this package's own `src/fixture-file.ts`, which gunzips on the `.gz` extension) or `replayStream` (`@etherfold/core`).
- **`*.state.json`** — the golden OUTPUT: the state the **ORIGINAL** stratagems `JSProcessor` computed from that stream (stratagems commit `3d5a0b3f`, 2024-12-18), key-sorted and with bigints in the repo's TAGGED convention. **A diff on it means the processor changed meaning, and that is a finding, not a fixture to update.**

  **It is a FROZEN expectation, not a recomputable one.** Producing it meant driving the vendored original through the free-form authoring path (`fromJSProcessor`); that path is deleted (ADR-0037), so `src/oracle.ts` and the `regenerate-golden-state` script are gone with it and these bytes can no longer be re-derived. This is a deliberate trade, and it costs little because regeneration was never the normal path: a difference here was always a FINDING. What changes is how one is triaged: by reading `../vendor/stratagems/js-processor.ts`, which is still committed and still typechecked, rather than by re-running it. Re-deriving these bytes would mean writing a driver for that processor again, which is exactly the thing that was removed.

## The encoding both files carry, and the one time it changed

A BigInt is written as `{"__bigint__": "123"}`, because a decoded `uint256` argument is ordinary and `JSON.stringify` throws on one. Both files were written with the `"123n"` SUFFIX until 2026-08-25; that convention could not tell a real BigInt from a string a contract emitted that happens to read like one, so it was replaced everywhere and these two files were re-encoded with it (the stream's `format` went `1` -> `2`; the state carries no format of its own and is simply re-rendered).

**The states behind the goldens did not move**, and that is not asserted, it is checked: `docs/spikes/tagged-bigint-codec-across-storage-adapters/prove-goldens-unchanged.mjs` re-renders the current golden in the OLD encoding and compares it byte-for-byte against the file as committed at `b40298e`. `reencode-stream-fixtures.mjs`, beside it, is the migration, and it refuses to convert any value whose declared ABI type is not an integer.

## Why the alpha1 stream is gzipped, and why `data` and `topics` came BACK

1.05 MB against 33.8 MB of JSON, so the compressed form saves 33 MB in every working tree. `loadStreamFixture` (`src/fixture-file.ts`) gunzips by extension, so no caller has to know.

**Each log's `data` and `topics` were omitted until 2026-09-06, and that made the fixture unusable as a stream SEED.** They are the encoded form of the `args` the fixture already carries decoded, so dropping them was sound for the thing it was then used as: a REPLAY input, fed straight to a processor by `replayFixtureInto`, which never re-decodes. It is fatal for a seed. `LogEventFetcher.reparse` refuses an event with no `topics` or `data`, because the decoded half is a cache re-derived against the source running now (ADR-0034), and the load path answers that refusal by CLEARING the stream. A keeper seeded from the decode-only file was therefore deleted on first load, every time.

So it was re-captured with `--full` (33.8 MB against 22.2 MB before, 1.05 MB against 0.65 MB gzipped), and it now carries the whole log. There is no `provenance.omittedFields` in it any more, and its absence is the signal: a fixture that omits fields says so, and this one omits none. The decision that turned on this is ADR-0063, and the negative control that keeps it honest is `docs/spikes/pin-the-seam-a-published-stream-arrives-through/`, which installs a stripped copy and asserts the subtree is cleared.

The re-capture is faithful, and that is checked rather than asserted: 31,332 events over 1,042 event-bearing blocks, the same event-name histogram, and the golden state below still reproduced byte for byte on the memory, sqlite and patch backends. Its `provenance` also moved from the legacy single-hash source context to the current per-entry form carrying `streamHash` values, which is what a capture taken through today's `sourceHashesOf` produces.

## Re-capturing

Deliberately a manual step, in the spike that produced them, because it is the one thing here that talks to a node: `docs/spikes/sqlite-in-the-browser/capture/capture-stratagems-base.mjs`, which needs `CHAIN_8453` in the repo's `.env.local`. **Pass `--full`**, which is what keeps `data` and `topics`; the committed `alpha1` stream is the THIRD capture (2026-09-06, chain head 50,968,313) and the first taken that way.

A re-capture is otherwise byte-identical apart from `capturedAt` and `chainHeadAtCapture`, which is how the earlier ones were verified. A fixture is a SNAPSHOT by definition, so pinning it to a stratagems commit and a block range is what keeps it honest indefinitely; re-capturing is not maintenance.

One thing that WOULD have stopped a re-capture, and no longer does: the merged three-contract source declares `Transfer` and `Approval` twice with different decoding shapes (Stratagems is ERC-721, Gems and GemsGenerator are ERC-20), and until ADR-0061 the fetcher refused the whole source at construction. Capturing, indexing and replaying this workload through the production path all depend on that relaxation.
