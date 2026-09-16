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
