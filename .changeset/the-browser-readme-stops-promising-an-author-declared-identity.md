---
'@etherfold/browser': patch
'@etherfold/utils': patch
---

**Two package READMEs stop telling a reader they can declare a processor's identity**, which is the exact thing ADR-0086 removed.

`packages/browser/README.md` closed its `processorIdentity` paragraph with "Leave it off and the generation keeps the author-declared identity the processor computes from its `version`, exactly as before" -- a sentence that cited ADR-0086 one clause earlier and then contradicted it, and did so at the point where the API is described, which is where most readers stop. The paragraph now says what omitting the field actually DOES: the identity is still DERIVED, a fold that arrived as a MODULE is named by a digest of its HANDLER SOURCES (`moduleProcessorIdentity`), so an edit moves it and a save that changed nothing does not and is answered `{stateDiscarded: false}`. It also states the two things the deleted clause left a reader to guess at: there is no declared `version` field to fall back on, because ADR-0086 deleted the field and the `getVersionHash()` that composed it, and a processor whose handlers have no readable source is REFUSED rather than named something no edit could move. The `processorIdentity` paragraph, the `updateProcessor` bullet and the derivation paragraph now say one thing.

`packages/utils/README.md` carried the same retired rule on the other arm of `openProcessorArrival`: an arrival with no `identity` was said to leave "the author's declared one" naming the fold. There is none, so such a deployment is refused -- at configuration resolution with the build command in it (`refuseUnbundledProcessor`), with `requireArrivalIdentity` as the structural backstop -- and the README now says so and says why neither refusal lives in the loader.

Documentation only; no published behaviour changes.
