# ADR Format

ADRs live in `docs/adr/` and use sequential numbering: `0001-slug.md`, `0002-slug.md`, etc.

Create the `docs/adr/` directory lazily — only when the first ADR is needed.

## Template

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. An ADR can be a single paragraph. The value is in recording _that_ a decision was made and _why_ — not in filling out sections.

## Optional sections

Only include these when they add genuine value. Most ADRs won't need them.

- **Status** frontmatter — useful when decisions are revisited. **ABSENT means accepted and current**, which is what most ADRs are, so add one only when the plain reading would MISLEAD. The vocabulary:

  | status | when |
  | --- | --- |
  | *(absent)* | accepted and current |
  | `proposed` | not decided yet |
  | `deprecated` | no longer the rule, with nothing replacing it |
  | `superseded by ADR-NNNN` | fully replaced |
  | `superseded in part by ADR-NNNN` | one axis replaced, the rest still holds |
  | `accepted, not yet implemented` | decided, and the code is kept compatible with it |
  | `accepted; the subject is built outside etherfold (ADR-NNNN)` | decided, and what it describes is not this repo's to build |

  The last three exist because "no code implements this" has three different causes and only one of them means the decision is dead. Reading a corpus without them, an ADR that is decided but not yet built, one that is partly replaced (ADR-0014, which ADR-0017 supersedes ONLY on which word the scope spells) and one whose subject lives in another repo (the trigger family, which ADR-0005 deliberately placed outside) all look identical to one that was abandoned. State which it is, and name the ADR that did the superseding or the placing.

  **`accepted, not yet implemented` is the one status with an expiry date, so REMOVING it is part of the work that implements it.** The line is a claim about the code, and it goes stale the moment the code lands rather than when anyone notices. Whoever lands the last piece deletes the line in the same change; a reviewer checking an ADR-bearing change should check for it the way they check for a changeset. Absence is the default and needs no ceremony.

  Do not lean on "the last task in the chain will do it", which is how this rule was learned: ADR-0006 was correctly marked pending on 2026-09-04 and implemented on 2026-09-05 (`packages/server/src/emissions.ts`, PR #62), and the line survived because every task in a chain can see that it is not the last one while the actual last one has no way to know that it is. ADR-0073 went the same way across ten tasks, with two builders looking straight at the line and each deferring to a successor. A deferral that is individually correct every time is collectively a hand-off with no holder. This paragraph also used to teach the vocabulary by naming a live pending ADR as its example; that example decayed along with the status it illustrated, which is why it is now described rather than named.
- **Considered Options** — only when the rejected alternatives are worth remembering
- **Consequences** — only when non-obvious downstream effects need to be called out

## Numbering

Scan `docs/adr/` for the highest existing number and increment by one.

## When to offer an ADR

All three of these must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it — you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library — just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements." "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it — otherwise someone will suggest GraphQL again in six months.
