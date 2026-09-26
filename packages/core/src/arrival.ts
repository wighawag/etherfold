import type {GenerationId} from './generation/registry.js';

/**
 * WHICH WAY a processor reached the running deployment, named after WHAT ARRIVED
 * rather than after the package that received it.
 *
 * - **`upload`** -- the bytes of an already-built bundle were SENT to a running
 *   `etherfold node` over its admin credential (`POST /{indexer}/admin/upload`,
 *   ADR-0085's amendment of 2026-09-22, ADR-0094). It is the ONE way code reaches
 *   a running Node process: a configured `etherfold run` receives no code and
 *   changes what it folds by restarting.
 * - **`hot-update`** -- a bundler replaced the module and handed the page a module
 *   OBJECT, which a tab registers itself (`reconfigureFromHotUpdate`).
 *
 * Not a package name, because a package is where the receiving code happens to
 * live and not what an operator saw happen: the upload spans `@etherfold/cli`
 * and `@etherfold/server`. What a log reader wants is "someone uploaded" versus
 * "a tab hot-updated".
 */
export type ReconfigureArrival = 'upload' | 'hot-update';

/**
 * WHAT ONE ARRIVAL DID, in the three answers a caller has to be able to tell
 * apart.
 *
 * A processor reaches a RUNNING deployment in more than one way -- UPLOADED as
 * the bytes of a bundle to a running `etherfold node` (ADR-0094), and HANDED
 * OVER as a module object by a browser tab's own hot update (ADR-0085) -- and
 * the thing those
 * arrivals have in common is the only thing that matters downstream: register
 * this processor as a successor beside the live one. They are thin adapters in
 * front of ONE call, so they answer ONE shape, and a watcher (or a tab's
 * reload indicator) branches on one contract rather than on one per arrival.
 *
 * Something calls an arrival after every build or every save, so "I saved the
 * file and nothing happened" must not be one shape with three causes: a
 * generation was REGISTERED, the arrival named the generation this deployment
 * already holds (`unchanged`), or it could not be completed at all (`failed`)
 * and the deployment is exactly as it was.
 *
 * `unchanged` is a SUCCESS and is deliberately not folded into `registered` with
 * a flag: it is the ordinary answer to an arrival that landed on the generation
 * this deployment already holds, so a developer reading it learns something true
 * rather than watching a no-op report success.
 *
 * ## `unchanged` MEANS WHAT IT SAYS, because an identity is DERIVED
 *
 * WHERE the identity came from is the arrival's business and not this type's
 * (ADR-0086), but every arrival derives one from what the processor IS: the
 * SHA-256 of a bundle's bytes, or a digest of the handler sources where there are
 * no bytes. So an edited handler always moves it, and `unchanged` is the honest
 * answer that these are the same bytes -- there is nothing an author could have
 * forgotten to declare, and nothing for a second opinion to disagree with. It is
 * therefore RARE, and it still has to be LEGIBLE rather than look like a
 * failure, which is what the `message` is for: a developer who saved without
 * changing anything is told so plainly.
 *
 * It used to read TWO ways, and a `drift` field on that arm was the answer:
 * under an author-DECLARED identity an edited handler and a save that changed
 * nothing produced the same `unchanged`, so the report said which. Both the
 * declared identity and the report are gone
 * (`the-declared-version-and-the-drift-report-are-deleted`), and the condition
 * `drift` named cannot occur.
 *
 * ## WHICH ARRIVAL, on a field BESIDE the outcome
 *
 * Every arm carries `arrival` (`ReconfigureArrival`), REQUIRED, because the same
 * outcome from two arrivals reads identically otherwise: "the upload said
 * unchanged" and "HMR handed us the same module" are one line in a log. It is a
 * field and NOT a fourth outcome, because it answers a different question: the
 * outcome says what HAPPENED and is what a watcher branches on, once, whatever
 * arrived; the arrival says where it CAME FROM and is what a reader of the log
 * tells apart. Folding the two into one discriminant would make every watcher
 * branch on three times as many values to learn the same three things. It is not
 * optional either, since an arrival that could leave it out is the log line this
 * exists to end.
 *
 * `failed` is DATA rather than an exception, because the failure is EXPECTED: a
 * processor that does not compile is the normal state between the two halves of
 * one change -- a developer saves mid-edit, and a dev loop meets this more often
 * than it meets success -- the next save repairs it, and a caller that had to
 * distinguish "the module is broken" from "this host threw" by inspecting an
 * error would be guessing. On every arrival the whole of what can refuse happens
 * BEFORE anything is registered, so a `failed` leaves the generations, the
 * canonical pointer and the fold exactly as they were.
 *
 * ## WHY IT LIVES IN CORE, and why it is not called `ReconfigureOutcome`
 *
 * It is here because the arrivals are in DIFFERENT PACKAGES -- the upload is
 * `@etherfold/cli` behind a `@etherfold/server` route, the hot update is
 * `@etherfold/browser` -- and this is the only package all of them already
 * depend on. Two packages that each declared their own three-arm union would
 * agree on the day they were written and drift one edit at a time afterwards,
 * which is the whole claim this type exists to make false. Core neither
 * PRODUCES nor CONSUMES one: it owns the vocabulary (`GenerationId`) the answer
 * is written in.
 *
 * The name `ReconfigureOutcome` is TAKEN, by a different question's answer: that
 * one rides out of `updateIndexer` and `updateProcessor`, the IN-PLACE verbs, and
 * says whether the fold it reconfigured was DISCARDED and what the source
 * comparison decided. Nothing is discarded here -- that is the whole of what "a
 * reconfigure is not an outage" means -- so there is no reset verdict to carry.
 * `@etherfold/browser` met the same collision a third time and answered it the
 * same way (`HostReconfigure`, "what a reconfigure did, as the TAB is told").
 */
export type ReconfigureReport =
	| {
			/** Which way the processor reached this deployment; see `ReconfigureArrival`. */
			readonly arrival: ReconfigureArrival;
			readonly outcome: 'registered';
			/** The generation that was registered BESIDE the incumbent, which is what the caller asked to learn. */
			readonly generation: GenerationId;
	  }
	| {
			readonly arrival: ReconfigureArrival;
			readonly outcome: 'unchanged';
			/** The generation the arrival named, which this deployment was already holding a fold for. */
			readonly generation: GenerationId;
			/** WHY nothing was registered, in terms an author can act on. */
			readonly message: string;
	  }
	| {
			readonly arrival: ReconfigureArrival;
			readonly outcome: 'failed';
			/** What went wrong, as the caller's watcher will print it. */
			readonly message: string;
	  };
