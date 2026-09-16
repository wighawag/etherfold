---
title: 'A processor artifact is PUSHED to a running deployment, for a process with no filesystem access to the build'
slug: a-processor-artifact-is-pushed-to-a-running-deployment
taskedAfter: [a-processor-is-a-bundle-and-its-hash-is-its-identity]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **CARVED 2026-09-16 from `a-processor-reaches-a-deployment-however-it-arrives`.** That spec proposed THREE arrivals for a processor and was moved to `work/specs/tasked/` after only its browser arrival (stories 1-3, `an-hmr-update-reconfigures-the-tab-it-is-running-in`) was tasked. Its pushed-arrival stories were never tasked, so its residence in `tasked/` was claiming something untrue. They are carried here, unchanged except where ADR-0086 overtook them, and the original records the carve.

## Problem Statement

A processor reaches a running deployment by being RE-READ: the process re-resolves its own configuration and re-loads its module. That works when the deployment can see the build, and there are deployments that cannot. A Cloudflare Worker has no filesystem to read a module from. A container running a published image has no build directory. A CI system holding a freshly built artifact has nowhere to put it that the running process can reach.

For those, "a processor is code and cannot cross HTTP" is true of a module OBJECT and false of a module's BYTES, and `a-processor-is-a-bundle-and-its-hash-is-its-identity` has made every processor a self-contained bundle whose hash is its identity. The bytes now exist, they are addressable, and nothing carries them.

## Solution

An authenticated admin route accepts a processor ARTIFACT and registers the generation it names, beside the incumbent, exactly as the re-read arrival already does.

Everything about what happens AFTER the bytes arrive is already built: the artifact is instantiated, a generation is registered as a `successor`, the incumbent goes on answering, and the promotion policy decides when the pointer moves. This spec adds the wire and the refusals, and it deliberately adds nothing else. The third arrival, HMR in a browser tab, needs none of this and is already specified.

What makes the three arrivals ONE feature rather than three is that they answer the SAME three outcomes in the same shape (`registered`, `unchanged`, `failed`), and say which arrival did it.

## User Stories

1. As a CI system or deploy hook, I want to push a built artifact to a running deployment over the admin credential, so that a deployment with no filesystem access to my build can still pick it up.
2. As an operator, I want a pushed artifact that is not self-contained to be REFUSED with the reason, so that a bare specifier fails at the push instead of at the first event it folds.
3. As an operator, I want the push BOUNDED in size and stating its content type, so that this endpoint cannot be used to exhaust the process.
4. As an operator, I want a pushed processor that fails to evaluate to leave the deployment exactly as it was, with nothing partial registered, exactly as a failed re-read already does.
5. As an operator, I want the three arrivals to report the SAME three outcomes in the same shape, so that a watcher branches on one contract rather than three.
6. As an operator, I want to know WHICH arrival registered a generation, so that "the endpoint says unchanged" and "HMR handed us the same module" are distinguishable in a log.
7. As an operator, I want the push to sit on the same credential and the same refusal shapes as the other admin routes, so that there is one authorisation story and not a second one invented for this verb.

### Autonomy notes

Neither gate. The refusal shapes, the credential and the three-outcome contract are all established by the existing admin surface, and the artifact itself is `a-processor-is-a-bundle-and-its-hash-is-its-identity`'s to define. What is left here is a route and its bounds.

## Implementation Decisions

**It is an admin route on the existing credential**, beside the reconfigure endpoint and the pointer move, for ADR-0057's recorded reasons. A surface that registers a new fold is at least as consequential as one that moves the pointer, and inventing a second authorisation story for it would leave two.

**The identity is the hash of the received bytes, computed by the receiver and never taken from the sender.** Under ADR-0086 that is simply what identity IS, so this route inherits it rather than deciding it. A sender-supplied identity would be a claim to verify; a receiver-computed one is a fact.

**The size bound and the content type are stated and enforced**, because an unbounded body on an authenticated route is still a way to exhaust a process, and the admin credential is not a reason to skip the bound.

**Validation happens BEFORE anything is registered**, which is the rule the re-read arrival already follows: a processor that throws on evaluation must leave the deployment exactly as it was, rather than being unwound afterwards.

**The arrival is NAMED in the outcome.** The three outcomes stay three, and which arrival produced one is a field beside them rather than a fourth outcome or a second shape.

## Testing Decisions

The claim worth asserting is the round trip at the seam an operator actually uses: a running deployment, a bundle pushed over the route, a generation registered beside the incumbent, and the incumbent still answering reads throughout.

Each refusal is its own case and each must leave the deployment untouched: a bundle that is not self-contained, a body over the bound, a wrong or missing credential, and a processor that throws on evaluation. The last is the one worth driving hardest, because "nothing partial is registered" is the property that distinguishes failing before registering from unwinding after.

The three-arrivals-one-contract claim is assertable across the re-read and the pushed arrivals in one test, with the browser arrival's own suite holding up the third corner.

## Out of Scope

- **Defining the artifact, its hash, or the instantiation path**, which is `a-processor-is-a-bundle-and-its-hash-is-its-identity` and is a hard dependency.
- **The browser arrival**, already specified and tasked as `an-hmr-update-reconfigures-the-tab-it-is-running-in`.
- **Retaining a pushed artifact so a generation can be resumed later**, which is `a-generation-retains-the-code-that-folds-it`. Retention does not need this route, and this route does not need retention.
- **WASM**, and **watching files**: ADR-0085 records why the first is out, and whatever notices a change stays outside the process, which is a rule this spec instances rather than revisits.
