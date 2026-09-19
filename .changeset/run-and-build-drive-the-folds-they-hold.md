---
'@etherfold/core': minor
'etherfold': minor
---

`run` and `build` drive the folds their container HOLDS rather than one receiver captured at `open`, and a `build` settles its pointer before it exits.

The first piece of ADR-0087. The combined CLI was the one place left that remembered a single receiver instead of asking which contexts are LIVE, and the one-shot was the one command that never settled.

**`createDirectIngestion` takes a `LiveIngestions` function as well as one `LogIngestion`.** A caller holding a GENERATION CONTAINER has no single receiver to hand over: the container holds several folds, only some of them have one — a FOLLOWER re-folds a stored stream and is deliberately not addressable on the wire (ADR-0044) — and WHICH of them is live moves while the process runs. On that arm the target routes exactly as the ingest route does, selecting on the batch's own `{source, config}` with `sameWireContext`, so the combined shape and the split shape route on ONE fact. It is a widened parameter rather than a sibling function, because there is one concept here and a second name for it would be a second thing to keep in step.

```ts
createDirectIngestion(() => container.liveIngestions());
```

**`NoLiveReceiverError` is what it answers when nothing matches, and `retryable` is a fact about the instance.** Live receivers exist and none is yours is a MISCONFIGURATION, exactly like `WireContextMismatchError`, so it is not retryable. NOTHING live at all is a fact about the MOMENT — what a container whose every held fold is a follower answers — and the container's own machinery closes it, since a bounded rebuild advances the follower and writer succession hands it the wire once it is level (ADR-0044's second amendment). So that one IS retryable: the host stays up, goes on rebuilding, and says so every cycle, which is that amendment's own trade — an unfed stream is visible and recoverable where a silently idle one is neither. It names EVERY live context rather than picking one, for the ingest route's own reason. What it never does is invent an `expectedFromBlock`, which would be a fetcher fetching ranges into nothing.

**The CLI's fetch assembly no longer reads `container.ingestion`.** That getter throws — "the opening fold of this `ReceivingIndexer` has no receiver, which `open` cannot produce" — and the whole assembly rested on it, so a restarted deployment whose only fold is a follower could not have STARTED. `FoldingAssembly.streamBuilder`, `PreparedIndexing.streamBuilder` and `RunningIndexer` / `RunningReceiver`'s are now OPTIONAL and read off the held fold, where the receiver is already optional: they REPORT which engine a process came up folding and nothing feeds through them.

**A re-run `build` exits with the pointer on the generation it just folded.** `driveCycles` wrapped its whole rebuild-and-settle block in `if (!stopAtTip)`, so a `build` settled nothing, ever. That was not hypothetical: re-run a `build` over a database it already wrote with CHANGED processor bytes and it is a different identity, so the container registers a successor beside the canonical generation exactly as a restarted `run` does, folds it to the tip — and then exited with the pointer still naming the OLD generation, publishing an artifact that served the old fold with a fully caught-up newer one beside it. The one-shot now takes the same bounded step `run` takes between cycles, ONCE, after the loop and beside the retention pass that is there for the identical reason. It advances every follower it holds by one chunk and settles once; it does NOT wait for anything to catch up, because a settle that waited would make the one-shot unbounded. A `build` stopped from outside skips it, on the same rule as the prune.

**`run` is unchanged.** Its loop already settled every cycle and still does, once.

**`build`'s docstring is CORRECTED rather than made true by refusing.** It claimed a one-shot "opens the container with one fold and exits, so it never adds a second and never promotes"; the first half is measured false and the second was true only because of it. Refusing to register the successor would have been a new refusal an operator meets on the ordinary redeploy, where folding the new generation and publishing it costs nothing and is what the generation model is for. `--promotion` is still refused on `build`, and its message now says what the command DOES (takes no input; settles its one successor under the default policy) instead of the claim that it never promotes.
