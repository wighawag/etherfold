---
status: accepted, not yet implemented
---

# The install is SELF-SUFFICIENT: it carries the address it writes to, and refuses any subtree it did not find empty

Two rules, one principle. An install must not depend on AMBIENT STATE it cannot verify:

1. **It takes the RESOLVED stream config as an argument** and sets it on the keeper itself, so the subtree it addresses is a function of what it was handed rather than of whatever a previous caller left configured.
2. **It installs only into an EMPTY subtree** -- no cursor record and no segments -- and REFUSES anything else as data. An interrupted install therefore leaves a prefix that the client CLEARS and re-installs, rather than continuing.

The second withdraws ADR-0063's claim that a partial install is a resumable prefix. ADR-0063 is otherwise unchanged and remains the arrival seam and the three block rules.

## Why resuming cannot be done safely, which is the whole of it

ADR-0063 reasoned that installing as N `saveNewEvents` calls makes an interrupted install "a contiguous prefix with an honest cursor", resumable by continuing from `lastToBlock + 1`. The prefix part is true. The RESUMABLE part requires something nobody has: a way to tell **a partial install of THIS seed** from **a stream this client indexed itself**.

Everything available to the reader is blind to that distinction in the case that matters. `fetchFrom` hands back the stored `context` and the three block numbers; it does not expose the cursor's `startBlock`. And in the deployment this feature exists for, the publisher and the client are THE SAME BUILD (`work/notes/findings/how-a-shipped-browser-indexer-is-actually-deployed.md`), so a locally-indexed stream and a seed-installed one carry an IDENTICAL `context`: same source hashes, same config hash, same everything a comparison could key on. What is left is "is `lastToBlock` inside the seed's coverage", which a locally-indexed stream satisfies trivially.

So a resuming install would continue into a stream it did not write. The damage is not a refusal:

- if the seed's next batch OVERLAPS what local indexing already stored, the keeper accepts it as an ordinary tip re-scan and the events are stored TWICE, so the fold double-counts;
- if it starts above, the keeper refuses the batch for leaving a hole, and the install stops half-done;
- and the stream's `startBlock` remains wherever local indexing put it, which is not the capture's `fromBlock`, so ADR-0063's first block rule is violated and the next load clears the whole subtree.

All three are silent at install time. That is a bad trade for a convenience, and the convenience is small: in the recommended single-document shape a resumed install re-fetches and re-parses the document anyway, so what resuming saves is the keeper writes alone, measured at roughly 200 ms of a ~1 s install on a real device (`work/notes/findings/what-a-published-stream-seed-costs-to-install.md`).

**So: empty or nothing.** A non-empty subtree is refused with its own reason, and a client that wants to install over one CLEARS it first, deliberately, which is a decision the caller makes rather than one the loader infers.

## Why the install carries its own address

`keepStreamOnIndexedDB` resolves the subtree from the `source` it is handed on every call plus the stream config it was last GIVEN, which starts at a resolved default and is set by `IndexerGeneration.reinit`. An install that relied on that ambient value would address the right subtree only if a generation had already been constructed, and the WRONG one otherwise -- silently, since a valid stream would be written where nothing will read it.

Taking the resolved config as an argument removes the ordering hazard entirely rather than documenting it. The install is then correct whether it runs before or after a generation exists.

**This corrects a rationale, and the correction matters more than the rule.** The browser hook's optional `seed` option was justified on the claim that only the hook knows when the address is configured, so an app installing "too early" would fail silently. With the install carrying its own config that failure mode does not exist, and the hook option is ERGONOMICS: it saves an app from sequencing the call itself and gives the status surface something to publish. That is a good enough reason to keep it, and it must not be sold as a safety mechanism it is not.

## Considered options

- **Expose the cursor's `startBlock` on the read seam** so a reader could tell a seeded stream from a local one. Rejected for now as the largest change for the smallest gain: it widens a seam third parties implement (ADR-0060, ADR-0044) to serve one caller's convenience, and it still would not distinguish two SEEDED installs of different artifacts.
- **Write a marker beside the cursor** naming the artifact an install is in progress from. Rejected on the same ground plus a new stored record and its own damage rules; the segment keeper's contract deliberately holds one cursor and its segments and nothing else.
- **Keep resuming, and accept the blindness.** Rejected: the failure is silent, it corrupts rather than refuses, and it lands in exactly the deployment shape the feature is for.

## Consequences

- **ADR-0063 is superseded in part**: its "a partial install is a contiguous prefix, not damage" reasoning stands as a description of what the keeper leaves behind, but the conclusion that a later install RESUMES from it does not.
- **The refusal vocabulary gains a reason for a non-empty subtree**, alongside ADR-0064's identity reasons and ADR-0065's integrity and coherence ones.
- **The follow-on spec's resume story changes shape**: what is asserted is that an interrupted install is refused and cleared rather than silently continued, which is a test about damage that does not happen rather than a feature.
- **Nothing changes for the ordinary path.** A first install on a fresh client finds an empty subtree, which is the case the whole capability is for.
