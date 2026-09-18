---
title: 'A path naming an UNBUNDLED entry point is refused at configuration resolution, naming the command that fixes it'
slug: a-path-naming-an-unbundled-entry-point-is-refused
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [the-declared-version-and-the-drift-report-are-deleted]
covers: [4]
---

## What to build

The migration's front door, made kind.

Naming a PATH in a configuration is still how an ordinary deployment says which processor it runs, and that does not change. What changes is what the path must point AT: a self-contained bundle, which the runtime reads and hashes. An author whose configuration still names an unbundled entry point must be told so at CONFIGURATION RESOLUTION, before anything opens a database, and told the exact command that produces a bundle.

This is the one moment where the migration ADR-0086 imposes meets a human, and the difference between a good refusal and a bad one is whether they are back to work in five minutes. A stack trace from inside a loader is a bad refusal. "This path names an entry point rather than a bundle; run this command" is a good one.

## Acceptance criteria

- [ ] A configuration naming an unbundled entry point is REFUSED at configuration resolution, before any database is opened and before any generation is registered.
- [ ] The refusal names the path it read, says what is wrong with it in a sentence, and gives the build command that produces a bundle.
- [ ] A configuration naming a genuine bundle resolves and runs, so the refusal cannot be met by anyone who has migrated.
- [ ] The refusal follows the rules every other command input obeys (ADR-0048) rather than inventing a second shape.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`the-declared-version-and-the-drift-report-are-deleted`. Until the declared path is gone, an unbundled entry point is still a legitimate configuration and refusing it would be wrong.

## Prompt

The goal is that an author who has not yet bundled gets five minutes of work rather than an afternoon of confusion.

Read **ADR-0086** for why a bundle is required at all, **ADR-0048** for how a command input is named and refused in this repo, and the CLI's configuration resolution, which is where this refusal belongs and where the other input refusals already live.

The decision most likely to be got wrong is WHERE this fires. It must be at configuration resolution, not at instantiation: by the time a loader has the bytes, a database may be open and a generation may be part-way registered, and the author gets an error about module syntax rather than about their configuration. Refuse before the first write, which is the ordering this repo uses everywhere.

The second: detecting "this is not a bundle" must be a real check with a low false-positive rate. An unresolved bare import is the signal the artifact unit already checks for; reuse that judgement rather than inventing a second heuristic, and be careful that a legitimately bundled file that happens to mention a package NAME in a string is not refused.

The third: the message is the deliverable. Name the path, say what it is, give the command. Resist explaining ADR-0086 in the error text; link the concept and keep the sentence short.

The seam to test at is the CLI's existing configuration tests, which already assert refusals for other bad inputs.

Done means: an unbundled path is refused early with an actionable message, and a bundled one runs.

## Decisions

**The refusal is a SEPARATE async function beside `resolveCommandConfig`, not inside it.** `resolveCommandConfig` is documented and tested as pure, total and synchronous ("it opens nothing, dials nothing and imports nothing"), and `--processor` is the one input whose value is a PATH, so what is wrong with a bad one is a fact about the FILE. Making the whole resolver async and disk-touching to carry one input would have cost every other refusal its property. Alternative considered: put the check inside `openProcessorArrival` (rejected: that IS the loader, which is the placement the task names as the likely mistake). What it touches: three call sites (`prepareIndexing`, `indexCommand`, `reconfigure`) now each call it explicitly, and the ordering claim in each of their docstrings.

**A path this process cannot READ AT ALL is refused by the same refusal, not only an entry point that still imports.** A bare package specifier, a directory, or the output of a build that has not run previously fell through to the module route and failed with `ERR_MODULE_NOT_FOUND` from inside a loader. Under ADR-0086 none of them can name a fold, and "the build has not run yet" is the commonest way to meet this at all, so it gets the same message with `--outfile=<the path you named>`. This is a NEW user-visible refusal shape for `-p @scope/some-package`, which is why I am flagging it rather than burying it. Alternative considered: refuse only the entry-point case and leave unreadable paths to the loader (rejected: two different errors for one configuration mistake, and the loader's is the one an author cannot act on). What it touches: nothing configures a bare specifier today; `the-build-command-and-its-pinning-rule-are-documented` should describe one input with one rule ("a path to a self-contained bundle").

**A SUBSTITUTED arrival (`IndexingDependencies.importModule`) is exempt, and this answers the question that task left open.** `processorIdentity`'s docstring says explicitly that "whether an injected importer remains an accepted arrival at all is `a-path-naming-an-unbundled-entry-point-is-refused`'s question". It does: a caller that stated what comes back for a path has stated that there is no file to read, so the disk check says nothing. No flag and no environment variable reaches it, so it is not a way for a deployment to get round the refusal. Alternative considered: refuse regardless (rejected: it would break ~20 CLI suites that name a path no file backs, for no deployment-visible gain, and it would delete the arrival-substitution seam as a side effect of a message change). What it touches: every CLI test that injects `importModule`, and `IndexingDependencies.processorIdentity`'s open question, which is now closed.

**`requireArrivalIdentity` is KEPT and narrowed rather than deleted.** Its own docstring said this task "moves this to CONFIGURATION RESOLUTION"; I moved the refusal an author meets, and left the structural guarantee that no fold is registered without a name. It is still reachable by a substituted arrival that named itself nothing, and by a path whose bytes MOVED between the configuration check and the loader's read (a half-landed rebuild), which now fails closed instead of folding under a name nothing derived. Alternative considered: delete it and require the identity in the type (rejected: it would take the substituted-arrival case with it, which is a test seam four suites rest on, and the TOCTOU window would become unhandled). What it touches: `folding.ts`'s docstring, and `aDeploymentRunsFromABundle.test.ts`'s injected-arrival case, which still asserts the old message.

**`@etherfold/utils` gains a public `readProcessorPath`, so "what is at this `--processor` path" is written once.** The CLI needed the bytes AND which case it met; the arrival needs only "bundle or not". Rather than the CLI re-implementing the `isAbsolute`/`join(cwd, …)`/read rule, both now go through one function. Alternative considered: three lines of path resolution duplicated in `config.ts` (rejected: two resolution sites for one path is exactly how a check refuses a deployment that runs). Note the residual cost I accepted: the file is read twice per start-up, once by the check and once by the loader, which is also what makes the TOCTOU case above fail closed. What it touches: `@etherfold/utils`' published API (covered by the changeset, `minor`).

**The refusal pins the build command, which `the-build-command-and-its-pinning-rule-are-documented` must match.** It emits `esbuild <entry> --bundle --format=esm --minify --outfile=<bundle>`, the command the two committed fixture READMEs and the example already use, written in one place (`bundleCommand`) with the `--minify` identity reason at the site. That task's criterion "the error and the docs say the same thing" is therefore satisfiable by quoting this.
