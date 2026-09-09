---
status: superseded by ADR-0037
---

# A processor module declares its KIND by returning a tag, and an untagged module means `js-object`

> **SUPERSEDED (2026-09-02) by the execution of ADR-0037.** There is one authoring path now, so a module has no kind to declare: `createProcessor` returns the AUTHORING object itself and `instantiateProcessor` (`@etherfold/utils`) REFUSES a module that still returns `{kind, processor}` rather than unwrapping it. What survives is the reasoning under "Why a tag and not a sniff" and "What the tag CARRIES differs from the browser's": a module hands over declarations plus handlers and NOT a runtime, because where the state lives is the deployment's choice. Read the rest as history.


A processor module loaded by a host says which of the two authoring paths it carries by having `createProcessor` return **`{kind: 'entities', processor}`** — the same two words and the same shape `@etherfold/browser` already takes from a caller (`ProcessorKind` / `TaggedProcessor`). A module that returns a bare processor means `'js-object'`, which is what every module that ships today does, so none of them changes. `etherfold index` reads that tag and checks it against `--store`; a mismatch is refused, naming both, before any RPC call.

## Why it is not a flag

`--store` and the module's kind look like one question asked twice, and they are not: `--store` is where the STATE goes, which is a deployment's decision, and the kind is what the processor IS, which is a fact about the code. A `--kind` flag would have been a second source of truth for the second one, and two answers that can disagree is precisely what the browser's tag exists to prevent — the wrong branch does not fail, it indexes into the wrong place and keeps going. So the operator names the store, the module names the kind, and the CLI's only job is to notice when they cannot both be true.

## Why a tag and not a sniff

Both kinds are `EventProcessor`-shaped, so "does it have `createInitialState`" or "does it have `entities`" is a guess that a wrapper, a proxy or a decorator can make wrong in silence. `@etherfold/browser` already refused that reasoning for the same reason and reads a discriminant somebody wrote (`'kind' in given`); this reads the same discriminant off the same property, so a reader who has met one has met both.

## What the tag CARRIES differs from the browser's, deliberately

The browser is handed a processor already bound to a store, because the application built the store first. A module cannot do that: WHERE the state lives is the deployment's choice, and a module that picked one would have picked for every host that loads it. So the `'entities'` arm of a module's tag carries the AUTHORING object (`EntityProcessor`: declarations plus handlers) and the host builds the runtime — `new EntityEventProcessor(store, processor)` — around it. Same word, same shape, one level lower, which is stated at `ResolvedProcessor` in `@etherfold/utils` so the difference is met at the type rather than discovered.

## Considered and rejected

- **A separate named export** (`export const entityProcessor = …`), with the kind inferred from which export exists. It reads as a tag but behaves as a sniff: a module carrying both exports has said two things, and nothing catches it.
- **A `processorKind` export beside `createProcessor`.** Two exports that can disagree, and nothing makes them travel together; the tagged return makes the kind and the thing it describes one value.
- **A field on the processor object itself.** It would put a host's question inside the authoring surface, and `entities.ts` in `examples/event-processor-nfts` must run unchanged in a tab and under the CLI — a processor that had to declare how it is loaded would no longer be backend-neutral.

## Consequences

- `instantiateProcessor` (`@etherfold/utils`) keeps returning the `EventProcessor` its existing callers expect, unwrapping a `'js-object'` tag, and REFUSES an `'entities'` module rather than handing back an object that is not an `EventProcessor`. Hosts that can build a store call `instantiateProcessorWithKind` instead.
- The vocabulary is duplicated, not imported: `ProcessorKind` is declared in `@etherfold/utils` as well as in `@etherfold/browser`, because a module loader must not depend on a browser runtime to type a module's export. The two are the same union of literals and `CONTEXT.md` defines the term once; if a third host appears, that is where they should meet, not in either package.
- `work/specs/tasked/one-command-runs-the-whole-pipeline.md` names this decision as the thing its story 2 assertion (the same processor object under `run` and in a tab) was waiting for: the tag is what the browser and the CLI have to agree on, and this is the agreement.
