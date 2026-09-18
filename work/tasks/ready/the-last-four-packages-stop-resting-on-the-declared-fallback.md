---
title: 'The last FOUR packages stop resting on the declared fallback, and every witness left behind is labelled for the contract step'
slug: the-last-four-packages-stop-resting-on-the-declared-fallback
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [no-suite-or-example-still-rests-on-the-declared-identity]
covers: [6, 8]
---

## What to build

The SIXTH and genuinely last migrate batch, and the one that finishes the enumeration rather than guessing at it.

`no-suite-or-example-still-rests-on-the-declared-identity` built a PROBE for the thing a grep cannot see: a deployment that supplies no identity falls through `processorIdentityOf` to `processor.getVersionHash()`, so it is named by the author's declared `version` without ever mentioning it. That batch cleared `packages/cli`, `packages/utils` and `examples/event-processor-nfts`, then ran the probe across the WHOLE tree and found four more packages still resting on the fallback. The measurement is `work/notes/observations/four-more-packages-still-rest-on-the-declared-identity-fallback.md`, and it is READ-FIRST for this task.

| package | cases the probe failed |
| --- | --- |
| `packages/processor-sqlite` | 16 |
| `packages/conformance-workload-stratagems` | 14 |
| `packages/browser` | 10 |
| `platforms/nodejs-fetcher` | 6 |

Roughly 46 cases, owned by nobody. Every one of them is CORRECT today, which is why six batches in a row honestly reported themselves clean: each moved every site that SOURCES an identity, and none of them could see a run-time fallback.

**This batch is the whole remainder, and after it the sweep is complete.** The probe covered every package in the tree, and everything else came back green (`core`, `utils`, `state-store`, `processor-entities`, `server`, `platforms/nodejs`, `platforms/cf-worker`, plus `cli` and the example after the fifth batch). So there is no seventh batch to discover later; this is the end of the migrate phase.

**TRIAGE IS THE WORK HERE, not bulk migration.** The 46 are two different things wearing the same failure, and the observation deliberately did not separate them, because that is triage on the owning packages:

- a genuine REMAINDER is a case whose SUBJECT is something else entirely (a namespace, a retraction, a publish, a fetch loop) and which merely rests on the fallback to get a name. Migrate it: give it an identity the arrival supplies, exactly as the five batches before did.
- a genuine WITNESS is a case whose subject IS the declared path — it exists to prove that `version`, `getVersionHash()` or the drift report still work. Do NOT migrate it. Migrating a witness does not move coverage, it deletes it while leaving the code standing, which is the failure every batch in this family has been warned about. `packages/browser`'s single `aModuleIsIdentifiedByItsHandlerSources` failure is probably one of these; so, probably, is much of `processor-sqlite`'s `version.test.ts`.

**LABEL every witness you leave.** This is the criterion that makes this batch worth more than the migration it performs. `the-declared-version-and-the-drift-report-are-deleted` has now had its central premise proved false twice, both times because a remainder was invisible to a grep. A witness that is labelled — a comment naming ADR-0086, saying this case exists to prove the declared path still works, and naming the contract task as what retires it — is a remainder that can never surprise anyone again. The contract task then has a LIST rather than a search.

Nothing is DELETED here and nothing is REFUSED here, exactly as in the five batches before: the declared `version`, `getVersionHash()`, `getCodeFingerprint()` and the `PROCESSOR DRIFT` report all still exist when this finishes, and no configuration that resolves today stops resolving.

## Acceptance criteria

- [ ] The probe is re-run first, to GROUND the table above against the current tree rather than trusting it; the fifth batch and the browser's module-identity task have both landed since it was taken, so the numbers may have moved.
- [ ] In all four packages, every case whose identity fell through to `getVersionHash()` either takes an identity the ARRIVAL supplies, or is a deliberate WITNESS that is left working and LABELLED.
- [ ] Every witness left behind carries a comment naming ADR-0086, stating that it exists to prove the declared path still works, and naming `the-declared-version-and-the-drift-report-are-deleted` as what retires it.
- [ ] The report LISTS every witness left, by file and case, so the contract task inherits an inventory instead of a search. This list is the batch's most valuable output.
- [ ] Demonstrated the way the fifth batch demonstrated it: with both halves of the declared fallback made to throw locally (a scratch edit you do NOT commit), each of these four packages fails ONLY its labelled witnesses.
- [ ] Nothing is deleted: `version`, `getVersionHash()`, `getCodeFingerprint()` and the drift report all still exist and still work.
- [ ] Nothing is refused: no new user-visible refusal, because that is `a-path-naming-an-unbundled-entry-point-is-refused`'s subject.
- [ ] No file outside `packages/processor-sqlite`, `packages/conformance-workload-stratagems`, `packages/browser` and `platforms/nodejs-fetcher` is edited.
- [ ] The tree is GREEN.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`no-suite-or-example-still-rests-on-the-declared-identity`, which built the probe this task re-runs and which cleared the first three paths. It is done, so this is startable now.

## Prompt

The goal is that when the contract task deletes the declared identity, it already knows exactly what goes dark and has decided about each one in advance.

Read `work/notes/observations/four-more-packages-still-rest-on-the-declared-identity-fallback.md` FIRST -- it records the probe, the method and the counts. Then `work/tasks/done/no-suite-or-example-still-rests-on-the-declared-identity.md` for how the fifth batch handled the same problem, including its three labelled witnesses, which are the pattern to copy. Then `packages/core/src/internal/processorIdentity.ts`, the one expression where the fallback lives.

The probe is the method and it is worth restating, because it is what makes this batch decidable rather than a judgement call: patch both halves of the fallback to throw IN THE BUILT OUTPUT (`packages/processor-entities/dist/EntityEventProcessor.js`'s `entityProcessorVersionHash`, and `packages/core/dist/internal/processorIdentity.js`'s `processorIdentityOf` when `supplied === undefined`), then run each package's suite. Patching `dist` rather than `src` is the point: a package's own suites run against its own `src`, so only a CONSUMER of the built package is affected, which is exactly the dependency being looked for. `dist/` is gitignored, so a rebuild reverts it -- but confirm you have not committed any of it.

The decision most likely to be got wrong is treating all 46 as remainders and bulk-migrating them. Some are witnesses and migrating one destroys coverage this family still needs, right up until the contract step removes it deliberately. When a case is genuinely ambiguous, LEAVE IT AS A WITNESS and label it: a labelled witness costs the contract task one decision, while a wrongly migrated one costs it the ability to make that decision at all.

The second: `packages/conformance-workload-stratagems` is a conformance workload, so its cases are likely to be ordinary subjects (publishing, retraction, applying) that merely need a name. Prefer giving them an arrival-supplied identity over reshaping what they assert; none of them is about identity.

The third: stay inside the four packages. If the re-run probe shows a FIFTH package that the earlier measurement missed, do not expand into it -- note it in your report and leave it, so the scope stays reviewable and the pattern of discovering remainders late finally ends with a record rather than a surprise.

Done means: four packages off the fallback, every surviving witness labelled and listed, the probe green except for those witnesses, and the old form untouched.
