---
title: 'A change reaches a running deployment'
slug: a-change-reaches-a-running-deployment
---

## Problem Statement

Everything about reconfiguring an indexer is built except the way a reconfigure ARRIVES.

`a-reconfigure-is-not-an-outage` decided what happens when you reconfigure, and it works: a successor is registered beside the incumbent, nothing is discarded, the incumbent goes on answering every read, a follower is advanced by a bounded rebuild the host schedules, and the canonical pointer moves on its own when the successor is ready. None of that is in question here.

What is missing is the trigger. A generation is registered when a container OPENS, from configuration, and nothing in the CLI watches a file, no route adds a generation, and no signal asks a process to re-read. So a changed processor or source reaches a running deployment exactly one way: by stopping it and starting it again.

That is survivable, because the registry and the state are rows in a database, so a restarted process finds the incumbent already there and registers the successor beside it. But it is a restart: a real interruption, and not overlappable, since a second process against the same database takes the writer claim and the first one's next write is refused. And it is not what anyone believes happens, which is its own cost. A comment in the CLI said "a reconfigure can reach a long-running host", meaning only that such a host has time to advance a successor, and it was read by more than one person as meaning a reconfigure arrives at runtime.

The gap is felt hardest in development, where the loop is tight and the changes come in pairs: a source change usually lands first, the handlers that go with it follow a moment later, and in between the processor often does not compile at all.

## Solution

A deployment exposes an ENDPOINT that makes it re-read its own configuration and register whatever generation that now names.

Whatever notices a file changed lives OUTSIDE the process and calls that endpoint. That split is the decision the whole spec rests on. A file watcher inside the indexer would be development tooling by construction, which is what makes it tempting to gate behind a development flag and then need a second mechanism for production. An endpoint is called by a development watcher, a deploy hook or a continuous-integration step equally, so one mechanism serves every environment and the process never grows a dependency on how anybody's editor saves files.

The endpoint's job is RE-READ, not receive. A processor is code and cannot cross an HTTP boundary, so a deployment cannot be handed a new one. The watcher owns WHEN, the process owns WHAT.

Because the trigger is cheap, changes arrive in bursts, and two things that are tolerable once become the defining cases. A processor that does not compile is the normal state between two halves of one change, not an exception. And a burst of successors must not accumulate, because a generation cap refuses at its bound and never evicts, so a handful of saves reaches it and leaves an operator deleting generations by hand.

## User Stories

1. As a developer, I want a running deployment to pick up my edited processor without restarting it, so that changing a handler costs a rebuild rather than a restart and a re-open.
2. As a developer, I want the deployment to keep answering reads throughout, so that the tab I have open beside my editor does not go blank every time I save.
3. As a developer whose processor does not compile, I want the deployment to be exactly as it was and to tell me what was wrong, so that a broken intermediate state costs nothing and the next save repairs it.
4. As a developer, I want to be told WHICH generation the deployment registered, or that my change named the same one it already had, so that "I saved and nothing happened" is not three different outcomes wearing one face.
5. As a developer iterating quickly, I want a burst of changes to leave one successor rather than one per save, so that the tenth edit of an afternoon is not refused by a bound.
6. As an operator, I want the same endpoint to serve a deploy hook or a pipeline step, so that picking up a new build in production is the mechanism I already use and not a second one.
7. As an operator, I want the trigger to be authorised the way the other administrative action already is, so that the ability to start a fold is not a new security story.
8. As an operator on a deployment that cannot serve it, I want an honest refusal rather than a call that appears to succeed, so that I learn the capability is absent instead of waiting for an effect that will never come.

### Autonomy notes

Neither gate flag is set. The shape is decided (an endpoint, an external watcher, re-read rather than receive, the existing administrative credential), the two mechanism hazards are known and written down below, and the churn bound is an ordinary task. What remains is engineering rather than judgement.

## Implementation Decisions

- **The endpoint sits beside the existing pointer-move route and uses the same credential.** That credential is already deliberately a second one and never the ingest one, so the authorisation story is inherited rather than invented.
- **Re-reading means re-resolving configuration AND re-importing the processor module.** Both halves, because a source change and a processor change arrive together and either alone would half-apply the developer's intent.
- **The module cache has to be defeated deliberately.** The processor loader ends in a dynamic import, so re-importing an unchanged path returns the cached module and a reload would observe nothing. The loader already accepts an injected import function, so this can be supplied without changing its shape. Whichever route is chosen carries a cost worth stating: a cache-busting specifier adds a module instance per reload and none are collected.
- **A reload can legitimately register nothing**, because a generation is registered only when its identity differs and the processor half of that identity is a hash over the handlers' source text. A change carried by a closure-captured value hashes identically. This is why story 4 exists: the endpoint must distinguish registered, unchanged, and failed.
- **Failure must precede registration.** The registration path already guarantees that nothing is written for a refused generation and nothing partial survives one, so a failed import should abort before that point rather than unwind after it.
- **Debouncing belongs to the watcher.** A watcher firing per keystroke is the watcher's defect. Note that a correctly debounced watcher still produces one generation per successful build, so debouncing is not a substitute for the churn bound.

## Testing Decisions

The claim to test is "this running deployment picked up an edited processor", not "this function returned an object", so the seam is a deployment stood up the way the existing CLI tests stand one up, driven through the endpoint. The three outcomes of story 4 are each a case. Story 3 is tested by pointing a deployment at a module that throws on import and asserting the generations, the canonical pointer and the ability to answer reads are all unchanged. Story 5 is an end-to-end assertion over repeated calls, resting on the churn bound built separately.

## Out of Scope

- **A file watcher inside the indexer.** Deliberately, per the Solution. Shipping a reference watcher as separate development tooling is reasonable later; it is not this.
- **Receiving a processor over the wire.** Code does not cross HTTP, and inventing a format for it would be a much larger and worse feature.
- **Bounding the churn itself.** That is `a-successor-that-was-never-canonical-is-superseded`, which this spec depends on rather than contains: without it, story 5 cannot hold.
- **Which generation answers reads, and when the pointer moves.** Owned by `a-reconfigure-is-not-an-outage` and by the promotion policy, including whether a source change should promote sooner than a processor change.
- **Multi-tenancy.** A deployment holding several named indexers is `the-combined-run-holds-several-named-indexers`, whose cost is a configuration grammar rather than a trigger.

## Further Notes

The observation this spec comes from is `a-reconfigure-cannot-reach-a-running-run`, which carries the negative evidence (nothing watches, no route adds a generation, shutdown signals only) and the reasoning for the endpoint shape. The churn constraints are in `rapid-change-succession-hits-the-generation-cap`.
