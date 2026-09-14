---
title: 'The CLI selects its promotion policy, instead of silently taking the default'
slug: the-cli-selects-its-promotion-policy
spec: a-reconfigure-is-not-an-outage
blockedBy: []
covers: [5]
needsAnswers: true
---

## What to build

Reach a capability that is already built, argued for, and currently unreachable from the shape most people run.

`@etherfold/core` has three promotion policies. `on-catch-up` moves the pointer when the successor reaches the cursor the canonical generation had, which is what an app shipping to users wants. `immediate` makes the successor canonical the moment it is created, which is what a developer iterating on a handler wants, "because stale-but-complete answers from the fold they just replaced are more confusing than incomplete answers from the new one". `manual` moves only when asked, so an operator can inspect first.

No CLI command ever passes a promotion config. The container is opened without one, and there is no flag and no environment variable for it, so every CLI deployment silently takes `on-catch-up` and an operator who wants either of the others cannot ask.

This is story 5 of its spec finished rather than a new idea. That story already says the developer is the one who knows "whether my reconfigure made the old answers WRONG or merely INCOMPLETE", and the promotion policy is the lever that acts on that knowledge. The reporting half landed; the lever was built in core and never brought out to the CLI, so on the shape most people run the developer holds the knowledge and cannot act on it.

Expose it, following the configuration rules every other input already obeys: one name per input, a flag that beats the environment, neither present being a refusal rather than an invented default, and the same resolver every command reads. The existing default stays the default, because it is the safe value and the unsafe one should remain a deliberate opt-in.

Respect the one combination the runtime refuses. `immediate` together with dropping the previous generation is rejected on this runtime, and for a stated reason: `immediate` makes a successor canonical before it has caught up, so the previous generation must be retained until the successor reaches the cursor it had at the promotion, and that deferral is not built here. Accepting it anyway "would discard a complete state for an empty one with no fallback". The CLI must surface that refusal as a configuration error the operator can read, at start-up, rather than letting it surface from inside the container later.

Out of scope, deliberately: whether the DEFAULT should differ when the successor is on its own stream. There is a real argument that it should, because on a new stream the incumbent folded a different event set and its answers can be wrong rather than merely stale, but changing a recorded default is an ADR amendment and not a flag.

## Acceptance criteria

- [ ] A CLI deployment can run with each of the three policies, selected by a flag or by the environment, and the selected policy is what the container actually applies.
- [ ] With nothing specified the behaviour is exactly what it is today, so no existing deployment changes.
- [ ] A flag beats the environment, and an unrecognised value is REFUSED naming the values that exist, rather than falling back to a default.
- [ ] The refused combination (`immediate` with dropping) is reported at start-up as a configuration error naming what to use instead, rather than surfacing later from inside the container.
- [ ] The selected policy is visible in what the deployment reports about itself, so an operator can confirm what a running process is doing rather than inferring it from behaviour.
- [ ] The input is named and documented the same way every other configuration input is, and every command that holds generations accepts it.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None. It can start immediately.

## Prompt

The goal is that an operator can say whether a successor takes over as soon as it exists, when it has caught up, or only when asked.

Read `work/notes/observations/the-promotion-policy-is-unreachable-from-the-cli.md` for the gap and the argument. Then read `@etherfold/core`'s `generation/promotion.ts`, which is where the three values are defined and where the reasoning for each lives, including the paragraph explaining why there is deliberately no per-runtime and no per-environment default. Read **ADR-0048** and the CLI's configuration module for the rules every input obeys, since this is one more input and not a special case.

The decision most likely to be got wrong: do not add a development default. `promotion.ts` is explicit that the axis which would select one is not detectable, and says in as many words not to add a `process.env` sniff, an `import.meta.env.DEV` check or a per-package default. A flag is the correct way to express "I am iterating"; inferring it is the thing that shape exists to prevent.

The second: this is a configuration input, so it belongs in the shared resolver with the same flag-beats-environment rule and the same refusal shape as everything else, not read directly wherever the container is opened. A second configuration path for one value is how the uniformity that module is built on decays.

The seam to test at is the CLI's existing configuration tests for resolution and refusal, plus a deployment stood up under each policy asserting on when the pointer actually moves.

Done means: an operator can pick a policy, the default is unchanged, a bad value is refused clearly, and the combination the runtime cannot honour is refused before anything folds.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. What the input is named, and which commands accept it, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
