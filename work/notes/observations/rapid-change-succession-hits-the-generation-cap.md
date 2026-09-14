---
title: 'Rapid change succession exhausts the generation cap, because nothing supersedes a successor that never got promoted'
slug: rapid-change-succession-hits-the-generation-cap
observed: 2026-09-13
---

2026-09-13 — Raised by the author while designing the reconfigure trigger: in a dev setup a SOURCE change usually lands first, the processor is not updated yet (and may not even compile), and a second change follows moments later once it is. So changes arrive in quick succession, each one asking for a generation, and the second is asked for while the first is still catching up.

Checked what the system does today. Nothing corrupts and no refusal is partial, so this is a USABILITY wall rather than a correctness hole. But the wall is close, and each piece of it has a deliberate reason, so none of it can be moved casually.

## 1. Caps REFUSE and never evict, and the dev loop reaches them fast

`SERVER_GENERATION_CAPS` is `{maxGenerations: 4, maxStreams: 2}`, and the rule is explicit: "A cap is a COUNT that REFUSES at the bound and never evicts, so the only cost of a generous one is disk and the only cost of a mean one is a refusal an operator has to act on." A browser tab is tighter still (`BROWSER_GENERATION_CAPS`, two of each).

Walk the author's scenario against those numbers. A source change makes a new STREAM, so streams go to 2 of 2 immediately, at the bound. Each following processor edit keeps that stream and adds a GENERATION, so after roughly three saves generations reach 4 of 4, and the next edit is REFUSED until an operator deletes something by hand. In a browser tab, one successor is the bound.

The refusal itself is well built and worth keeping: registration happens at open "so a cap REFUSES at start-up, where an operator reads it, naming what could be deleted, instead of on somebody's ingest. Nothing is written for a refused generation, and nothing partial survives one." So the failure is clean and legible. It is simply the wrong failure for a loop where the count grows once per save.

## 2. Nothing supersedes an in-flight successor, which is the actual missing concept

The vocabulary of supersession in the container is exclusively about a PROMOTION: the incumbent becomes the predecessor and is RETAINED so the revert stays free. There is no notion of a successor that was never promoted becoming **dead work** when a newer one arrives for the same role.

So in a quick loop the older successor is not abandoned. It keeps its registry row, keeps its state namespace, and keeps being advanced by the scheduled bounded rebuild, re-folding the same stream as the newer one, competing for the same database handle. Every successor but the newest is wasted work that also consumes a slot.

This is the root of the wall. A cap is the right mechanism against slow accumulation; it is the wrong mechanism against churn, because under churn the count grows for a reason that will never be wanted. Fixing supersession bounds the count regardless of save rate, and is a better answer than raising the cap, which only moves the wall.

## 3. The combination a dev loop wants is explicitly REFUSED, for a stated reason

`immediate` with `dropOnPromotion` throws: "'immediate' makes a successor canonical BEFORE it has caught up, so the previous generation must be RETAINED until the successor reaches the cursor it had at the promotion (ADR-0046), and that deferral is not built here. Use 'on-catch-up' (the default) with dropOnPromotion, or 'immediate' while retaining."

So the two available shapes are "switch when caught up and free the slot" or "switch now and accumulate". A dev loop wants **switch now AND free the slot**, and that is exactly the combination not built on this runtime. The refusal is right rather than arbitrary: accepting it without ADR-0046's interlock "would discard a complete state for an empty one with no fallback". But it means the churn case has no configuration that survives it.

## 4. A processor that does not compile must be a no-op, not a half-applied reconfigure

The author's "it might fail to compile at first" is a first-class case, and it interacts with the DECIDED trigger shape (an endpoint a watcher calls, `a-reconfigure-cannot-reach-a-running-run`). Under the current restart model a failing import means the process fails to start, which is safe and obvious. Under an endpoint it must leave the running deployment exactly as it was and report the error, because the caller is a watcher that will fire again in seconds.

Worth stating for whoever builds it: the registration path already has the right property ("nothing is written for a refused generation, and nothing partial survives one"), so the endpoint's job is to fail BEFORE registering, when the import throws, rather than to unwind afterwards.

## What to decide

- **Supersede an in-flight successor** when a newer one is registered for the same role: drop the older one's registry row and state namespace, since it was never canonical and nothing can revert to it. This is the piece that makes the loop bounded, and it needs care about exactly one thing, which is that a successor is only dead work while it has NEVER been canonical.
- **Whether the cap should be raised as well**, or left alone once supersession bounds the count. Prefer leaving it: the cap's reasoning is sound and raising it treats the symptom.
- **Whether `immediate` with drop can be built here** by porting ADR-0046's interlock to the receiving runtime, since that combination is what a dev loop actually wants. Related: `the-promotion-policy-is-unreachable-from-the-cli`, which notes the policy cannot even be selected from the CLI today.
- **Debouncing belongs to the WATCHER**, outside the process, which falls out of the decided endpoint shape. A watcher firing per keystroke is the watcher's bug. But note that a correctly debounced watcher still produces one generation per successful build, so debouncing alone does not solve any of the above.
