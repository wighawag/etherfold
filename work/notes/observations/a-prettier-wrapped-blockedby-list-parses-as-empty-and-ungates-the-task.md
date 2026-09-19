---
title: 'A `blockedBy` list long enough for Prettier to wrap parses as EMPTY, so a fan-in task becomes claimable at once'
slug: a-prettier-wrapped-blockedby-list-parses-as-empty-and-ungates-the-task
observed: 2026-09-19
---

2026-09-19 — Measured while tasking ADR-0087. Not a defect in this repo's code; a collision between two tools this repo runs together, and it FAILS OPEN.

`dorfl`'s frontmatter parser handles exactly two list shapes, and says so in its own header: the inline flow form `[a, b]` and the block form `- a`. It does not implement general YAML. Prettier formats markdown frontmatter as YAML under `printWidth: 120`, so an inline `blockedBy: [...]` that exceeds 120 characters is rewritten into a MULTI-LINE FLOW list:

```yaml
blockedBy:
  [
    one-slug,
    another-slug,
  ]
```

That is valid YAML, it is what `pnpm format` produces, and it is neither of the two shapes the parser reads. The list silently becomes `[]`.

The consequence is the dangerous direction. A task written with four blockers was reported by `dorfl status` as `deps: satisfied (none)` and sat in "Agent-claimable now". Nothing warned. Had it not been noticed, the closing documentation task of an ADR family — the one whose whole purpose is to be unambiguously LAST, which `work/protocol/ADR-FORMAT.md` argues for at length — would have been claimable before any of the work it documents existed.

The trigger is length alone, so it fires precisely on the tasks most likely to need it: a fan-in with several blockers, which is exactly the shape `ADR-FORMAT.md` prescribes for expiring an `accepted, not yet implemented` status. Four slugs of this repo's usual length are about 300 characters, so any fan-in of three or more blockers is over the limit.

The workaround used here was the BLOCK form, which Prettier leaves alone and the parser reads:

```yaml
blockedBy:
  - one-slug
  - another-slug
```

Worth deciding rather than assuming: whether the task template should show the block form for multi-blocker cases, and whether a check belongs beside `check:refs` that refuses a `blockedBy` whose raw text contains a slug the parsed list does not — a cheap comparison that catches this whole class, including whatever the next formatter change produces. Not fixed here; the two tasks that needed it were converted by hand.
