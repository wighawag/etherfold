import {createHash} from 'node:crypto';
import {isBuiltin} from 'node:module';
import type {Abi} from '@etherfold/core';
import {instantiateProcessor, type ProcessorModule} from './processorSetup.js';

/**
 * A PROCESSOR ARTIFACT: a self-contained ESM bundle, plus the identity derived
 * from those bytes.
 *
 * Three capabilities live here and nothing in this repository consumes them yet
 * (`processorArtifactIdentity`, `unresolvedImportsOf`, `loadProcessorArtifact`).
 * That is deliberate: ADR-0086's migration is sequenced, and a caller moved onto
 * this unit before the batch that moves the rest would break a step that has not
 * been written.
 *
 * ## Why an artifact exists at all
 *
 * A processor's identity used to be AUTHOR-DECLARED (`version`, hashed with the
 * declarations into `getVersionHash()`), so an author who edited a handler and
 * forgot to bump it got state computed by the previous logic, served for ever
 * and silently. ADR-0086 makes that unrepresentable: a processor IS a bundle and
 * the hash of its octets IS its name, so an author cannot state an identity and
 * cannot fail to.
 *
 * Being BYTES buys three more things (ADR-0085): no filesystem, since the
 * artifact can arrive in a request; no cache breaker, since distinct bytes are a
 * distinct module by construction; and a unit a deployment can HOLD, which is
 * what lets a retained predecessor be resumed rather than merely read.
 *
 * ## WHICH runtime this serves, and which it deliberately does not
 *
 * The runtimes that receive BYTES: a CLI or a server reading a bundle from disk,
 * and later a pushed artifact. They instantiate by importing a `data:` URL,
 * which needs no filesystem and no temporary file.
 *
 * A BROWSER is NOT served here, and that is a decision rather than an omission.
 * A tab is handed a processor OBJECT its own bundler loaded (`IndexerState` takes
 * `processor:`, never bytes), so there are no bytes in a tab for this to load;
 * and where a tab does hold bytes -- a retained artifact -- `data:` and `blob:`
 * imports are refused by every realistic Content-Security-Policy, measured
 * across three engines (`work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md`).
 * A browser path is therefore a service worker serving a same-origin URL, which
 * is a component `@etherfold/browser` does not have and a decision that is not
 * this unit's to make. Which is also why this module lives in the node-side glue
 * package rather than in `@etherfold/core`.
 */

/**
 * THE IDENTITY OF SOME BYTES: `sha256:<64 lowercase hex>` over the bundle's
 * octets.
 *
 * ## The byte domain, which is the whole of the contract
 *
 * The octets as they are, and nothing derived from them: not a decoded string,
 * not a re-serialisation, not the base64 the loader happens to wrap them in on
 * the way to a `data:` URL. It takes a `Uint8Array` for that reason -- a caller
 * handing over text would have had to encode it, and two ends encoding
 * differently is an identity that disagrees with itself.
 *
 * ## Why the algorithm travels in front of the digits
 *
 * The same reason `streamSeedContentHash` renders it this way, and the
 * convention is reused rather than re-decided: this value is PASTED into
 * builds, logs and generation records, where it long outlives the session that
 * produced it, and a bare hex string cannot say which function produced it.
 * `sha256:` is the prefix an OCI image digest uses and it splits on one
 * character.
 *
 * ## Why `node:crypto` here where the seed path uses viem's
 *
 * Same algorithm, same octets, identical output; only the source of the
 * primitive differs. The seed path is in `@etherfold/core`, which a browser
 * bundles, so it needs a synchronous hash that is already a dependency there.
 * This package is node-side by definition (it reads the filesystem elsewhere),
 * so the runtime's own hash costs no dependency at all.
 *
 * Note what it deliberately is NOT: a MINIFIED bundle is required for this to
 * be stable across machines, because un-minified esbuild output carries a
 * per-module path banner and therefore the building machine's directory layout.
 * That rule belongs to the documentation of the build command; what belongs here
 * is that this function hashes exactly what it is given and makes no attempt to
 * normalise it.
 */
export function processorArtifactIdentity(bundle: Uint8Array): string {
	return `sha256:${createHash('sha256').update(bundle).digest('hex')}`;
}

/**
 * There is deliberately NO function here asking whether a string LOOKS like an
 * artifact identity, and the omission is load-bearing rather than an oversight.
 *
 * `GenerationId.processor` is a string the engine compares for equality and
 * renders into messages, and NOTHING in the tree parses it (ADR-0086). That is
 * what lets two arrivals derive an identity two different ways -- bytes hashed
 * here, handler sources derived in a tab that has no bytes -- and coexist through
 * the migration and after it. A predicate sniffing "is this a hash" would be the
 * first parser, and every caller reaching for it would be asking a question the
 * engine is not allowed to have an opinion on.
 *
 * The seed path's `pinnedStreamSeedContentHash` is not the precedent it looks
 * like: it validates a value a BUILD pasted in, against the artifact it is about
 * to fetch, and nothing pins a processor identity.
 */

/**
 * The MODULE REFERENCES a bundle still carries: the three STATEMENT forms that
 * can hold one, plus the dynamic CALL.
 *
 * Deliberately narrow rather than a parser, and the two halves of the
 * alternation are deliberately not equally strict.
 *
 * **A STATEMENT** must sit where a statement can start -- at the beginning of the
 * input, or after a `;`, a `}` or a line break, which is how every bundler
 * separates top-level statements -- and is then `import`/`export`, an optional
 * CLAUSE (identifiers, `{}`, `*`, `,` and whitespace: a character class that
 * cannot cross a `=`, a `;` or a parenthesis, so `export const x = 1` and
 * `export function f()` are not candidates), `from`, and a quoted specifier. A
 * specifier straight after the keyword (`import "x"`) is the clause-less case.
 *
 * **A CALL** (`import("x")`) can appear anywhere an expression can, so it takes
 * a loose boundary: the start of the input, or anything that is not an
 * identifier character, a `.` or a quote -- which is what keeps `import.meta`, a
 * property called `myimport` and the common quoted-source case out.
 *
 * The asymmetry is chosen on WHICH WAY each one fails. A missed STATEMENT costs
 * a less precise refusal and nothing else, because Node refuses to LINK such a
 * module anyway, so the loader still refuses the artifact and merely says
 * `unreadable-module` instead of naming the specifier. A missed CALL would admit
 * an artifact that fails at the first event it folds, which is the failure this
 * check exists to bring forward -- so that half stays loose, and its price is
 * that a bundle embedding `import("...")` inside a string literal can be
 * reported for an import that is not one.
 *
 * The clause is BOUNDED (rather than `*`) on purpose: a minified bundle is
 * frequently one line of several megabytes, and an unbounded run over it is how
 * a scan becomes the slowest thing in a start-up.
 */
const MODULE_REFERENCE =
	/(?:(?:^|[;}\r\n])\s*(?:import|export)\s*(?:[\w$*,{}\s]{0,512}?from\s*)?|(?:^|[^\w$.'"`])import\s*\(\s*)(['"])([^'"\n]*?)\1/g;

/**
 * WHAT A BUNDLE STILL EXPECTS SOMEBODY ELSE TO RESOLVE, in the order it carries
 * them and each named once. An empty list is what SELF-CONTAINED means.
 *
 * ## Why this is a check and not a docstring
 *
 * "Self-contained" is a property of an artifact that nothing about the artifact
 * announces. A bundle that survived bundling with an unresolved `import 'viem'`
 * in it looks exactly like one that did not, right up until it is instantiated
 * in another process, or -- for a specifier only a DYNAMIC import carries -- until
 * the first event it folds. Both failures land far from the cause, and both are
 * decidable here, cheaply, before anything is evaluated.
 *
 * ## What counts as resolved, which was MEASURED rather than assumed
 *
 * A `data:` URL has no base to resolve against, so a specifier that is not an
 * absolute URL simply cannot be resolved from one -- a BARE specifier (`viem`)
 * and a RELATIVE one (`./abi.js`) alike, which is why both are reported.
 *
 * The one exception is a BUILTIN, which does resolve, prefixed (`node:crypto`)
 * or bare (`crypto`). Measured against Node itself rather than read off a
 * document (`docs/spikes/a-processor-artifact-is-bytes-a-hash-and-a-loader/measure-what-a-data-url-can-resolve.mjs`),
 * because the alternative was refusing an artifact that runs -- a processor
 * bundled with `--platform=node` legitimately keeps those imports, and a
 * refusal an author cannot act on is worse than no check.
 *
 * Everything else is reported, including an absolute `file:` or `https:` URL:
 * those RESOLVE, and an artifact whose fold depends on the instantiating
 * machine's disk or on a network fetch is not one the identity covers.
 *
 * ## The limits, honestly
 *
 * It reads TEXT and is not a parser, so what it can get wrong is bounded by
 * where each half of `MODULE_REFERENCE` is strict -- read it, because the
 * asymmetry is the argument. A bundle embedding JavaScript source in a string
 * literal can be reported for an import that is not one: the safe direction,
 * since a refusal names the specifier and the author can see exactly what was
 * matched. A COMPUTED dynamic specifier (`import(name)`) is invisible to it, as
 * it would be to anything static.
 *
 * What it is NOT relied upon for is catching every STATIC import. Those cannot
 * be linked from a `data:` URL at all, so `loadProcessorArtifact` has Node
 * itself as a backstop and reports an unreadable module rather than admitting
 * one. This exists to refuse EARLY, to NAME the specifier, and -- for the dynamic
 * case, which Node would happily evaluate -- to refuse at all.
 */
export function unresolvedImportsOf(bundle: Uint8Array): readonly string[] {
	const text = new TextDecoder().decode(bundle);
	const unresolved: string[] = [];
	for (const match of text.matchAll(MODULE_REFERENCE)) {
		const specifier = match[2];
		if (specifier.length === 0 || isBuiltin(specifier) || unresolved.includes(specifier)) {
			continue;
		}
		unresolved.push(specifier);
	}
	return unresolved;
}

/**
 * WHY an artifact was not instantiated. DATA, so a host can render it and a
 * caller can branch on it.
 *
 * Three reasons and not one, because they have three different remedies: rebuild
 * the bundle, look at what produced these bytes, and look at what the module
 * exports.
 */
export type ProcessorArtifactRefusalReason =
	/**
	 * The bundle still expects somebody else to resolve a module (ADR-0085).
	 *
	 * The refusal NAMES the specifiers, because "this is not a bundle" is not
	 * actionable and "you still import viem" is. Reported before anything is
	 * evaluated (see `loadProcessorArtifact`).
	 */
	| 'not-self-contained'
	/**
	 * The bytes did not become a module: they do not parse as ESM, or the module's
	 * top-level code threw.
	 *
	 * ONE reason for both, in the manner the seed loader collapses every
	 * unreadable document into `unreadable-format`: a caller renders the same
	 * thing for each, and the distinguishing detail is carried in `why`.
	 */
	| 'unreadable-module'
	/**
	 * The module evaluated and carries no processor: no `createProcessor`, a
	 * factory that produced nothing, or the retired `{kind, processor}` tag
	 * (ADR-0037).
	 */
	| 'not-a-processor';

/**
 * WHAT A LOAD DID, as data. Nothing here throws for an ordinary condition,
 * because every condition above is ordinary for an artifact that came from
 * somewhere else.
 *
 * The IDENTITY is on BOTH arms, and that is the point of the unit rather than a
 * convenience: bytes have a name whether or not they turn out to be a processor,
 * so a refusal can say WHICH artifact it refused and a log can be correlated
 * with the thing that produced it.
 */
export type ProcessorArtifactOutcome<ABI extends Abi, ProcessResultType, EntityProcessorType> =
	| {
			readonly status: 'instantiated';
			readonly identity: string;
			/** The AUTHORING object the bundle's factory made: declarations plus handlers. */
			readonly processor: EntityProcessorType;
			/**
			 * The module itself, because a processor is not everything a bundle
			 * carries: `contractsData` / `contractsDataPerChain` ride on the module and
			 * are read by `resolveSource`, which is the caller's step and not this
			 * one's.
			 */
			readonly processorModule: ProcessorModule<ABI, ProcessResultType>;
	  }
	| {
			readonly status: 'refused';
			readonly identity: string;
			readonly reason: 'not-self-contained';
			readonly why: string;
			/** Every module this bundle still expects somebody else to resolve. */
			readonly unresolvedImports: readonly string[];
	  }
	| {
			readonly status: 'refused';
			readonly identity: string;
			readonly reason: 'unreadable-module' | 'not-a-processor';
			readonly why: string;
	  };

export type LoadProcessorArtifactOptions = {
	/**
	 * The argument handed to the bundle's `createProcessor`. Omitted means the
	 * factory is called with NO arguments, which is the call the CLI has always
	 * made -- the same explicit distinction `instantiateProcessor` draws, kept so
	 * a caller difference stays deliberate rather than accidental.
	 */
	processorConfig?: any;
};

/**
 * TURN BYTES INTO A RUNNING PROCESSOR: hash them, establish that they are
 * self-contained, and only then instantiate.
 *
 * ## The ORDER, which is the borrowed half
 *
 * Everything checkable happens BEFORE the irreversible act, which is the
 * ordering `installStreamSeed` makes structural. Here the irreversible act is
 * EVALUATION: a module joins the process's registry for the life of the process
 * (ADR-0085 is explicit that this leak is unchanged rather than fixed, and that
 * per-build rather than per-minute is the guidance), and its top-level code
 * RUNS. So a bundle that is not self-contained is refused against the BYTES and
 * never reaches an import -- which also means the dynamic case is caught, since
 * Node would evaluate such a module happily and fail at the first fold instead.
 *
 * ## Refusals are DATA
 *
 * Every outcome above comes back as a value. An artifact arrives from a build, a
 * disk or -- later -- a request, so "these bytes are not a processor" is an
 * ordinary thing to learn and a host renders it. Nothing here is a throw a
 * caller cannot branch on, and nothing is half-done on a refusal: no module is
 * evaluated for the self-containment case, and a module that evaluated and
 * carries no processor has produced no processor to unwind.
 *
 * It differs from the seed loader in one respect and deliberately: that one
 * LOGS which rule failed, because its reasons are coarse and the detail would
 * otherwise be lost. Here every refusal carries its own `why`, so the caller --
 * which owns the context worth logging, the path or the request the bytes came
 * from -- says it once instead of this unit saying half of it twice.
 *
 * ## No filesystem, by construction
 *
 * The bytes are wrapped in a `data:text/javascript;base64,` URL and imported.
 * There is no temporary file, no cache-busting query (distinct bytes are a
 * distinct module already) and no path involved at any point, which is the
 * property a pushed or retained artifact rests on.
 *
 * ```ts
 * const outcome = await loadProcessorArtifact<Abi, unknown, EntityProcessor<Abi>>(await readFile(path));
 * if (outcome.status === 'refused') return refuse(outcome);
 * const source = await resolveSource(outcome.processorModule, provider);
 * // outcome.identity is the generation's `processor` identity, and nothing parses it.
 * ```
 */
export async function loadProcessorArtifact<
	ABI extends Abi = Abi,
	ProcessResultType = unknown,
	EntityProcessorType = unknown,
>(
	bundle: Uint8Array,
	options?: LoadProcessorArtifactOptions,
): Promise<ProcessorArtifactOutcome<ABI, ProcessResultType, EntityProcessorType>> {
	const identity = processorArtifactIdentity(bundle);

	const unresolvedImports = unresolvedImportsOf(bundle);
	if (unresolvedImports.length > 0) {
		return {
			status: 'refused',
			identity,
			reason: 'not-self-contained',
			unresolvedImports,
			why:
				`the artifact still imports ${unresolvedImports.map((specifier) => JSON.stringify(specifier)).join(', ')}, ` +
				`which nothing can resolve for it: an artifact is instantiated from its own bytes, with no directory to ` +
				`resolve a relative path against and no node_modules to look a package up in. Bundle the processor into ` +
				`ONE self-contained module (ADR-0085).`,
		};
	}

	let processorModule: ProcessorModule<ABI, ProcessResultType>;
	try {
		// `@vite-ignore` because the specifier is a value: a bundler asked to analyse
		// it would try to resolve the artifact at build time, which is the one thing
		// this arrival does not have.
		processorModule = (await import(/* @vite-ignore */ dataUrlOf(bundle))) as ProcessorModule<ABI, ProcessResultType>;
	} catch (error) {
		return {
			status: 'refused',
			identity,
			reason: 'unreadable-module',
			why: `the artifact did not become a module: ${messageOf(error)}`,
		};
	}

	// The IDENTITY stands where a path would in `instantiateProcessor`'s messages,
	// because an artifact has no path to name and its identity is the name it does
	// have. And `processorConfig` is forwarded only when the caller supplied the
	// key, so the no-argument factory call stays exactly that (see the option).
	const instantiateOptions =
		options && 'processorConfig' in options
			? {processorPath: identity, processorConfig: options.processorConfig}
			: {processorPath: identity};
	try {
		const processor = instantiateProcessor<ABI, ProcessResultType, EntityProcessorType>(
			processorModule,
			instantiateOptions,
		);
		return {status: 'instantiated', identity, processor, processorModule};
	} catch (error) {
		// `instantiateProcessor` RAISES, by design, and this is the one place that
		// conversion happens -- the same shape as the seed loader catching
		// `parseStreamSeed`. It owns the module-shape rules (a missing factory, a
		// factory that made nothing, the retired kind tag), and a second copy of
		// them here would be a second answer to what a processor module IS.
		return {
			status: 'refused',
			identity,
			reason: 'not-a-processor',
			why: `the artifact evaluated but carries no processor: ${messageOf(error)}`,
		};
	}
}

/**
 * The bytes as a module URL.
 *
 * Base64 rather than percent-encoded text: a bundle is arbitrary JavaScript, and
 * `,` and `#` inside a plain `data:` URL end the payload. Note that this
 * rendering is NOT part of the identity -- that is over the octets -- so the
 * encoding can change without renaming a single artifact.
 */
function dataUrlOf(bundle: Uint8Array): string {
	return `data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`;
}

/** What went wrong, in words, for the `why` a caller renders. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
