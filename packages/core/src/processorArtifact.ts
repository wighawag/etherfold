import {sha256} from 'viem';
import type {Abi} from 'abitype';
import type {AllContractData, ContractData} from './types.js';

/**
 * THE RUNTIME-AGNOSTIC HALF OF A PROCESSOR ARTIFACT: what names some bytes, what
 * they still import, and what a module that evaluated must carry to be a
 * processor.
 *
 * Every arrival that HAS bytes needs all three, and there are two such arrivals in
 * two runtimes: Node reads or receives a bundle (`loadProcessorArtifact`,
 * `@etherfold/utils`), and a browser tab fetches the published one
 * (`loadProcessorBundle`, `@etherfold/browser`, ADR-0095). They live HERE, in the
 * one package both of those already depend on and a browser already bundles, so
 * that the two ends of a publication cannot answer "which bytes is this" or "is
 * this self-contained" differently. What stays in each runtime is only what
 * differs: how bytes become a module there, and which specifiers that runtime can
 * resolve (Node resolves its builtins; a tab resolves nothing from bytes).
 */

/**
 * THE IDENTITY OF SOME BYTES: `sha256:<64 lowercase hex>` over the bundle's
 * octets.
 *
 * ## The byte domain, which is the whole of the contract
 *
 * The octets as they are, and nothing derived from them: not a decoded string,
 * not a re-serialisation, not the base64 a loader happens to wrap them in on the
 * way to a `data:` URL. It takes a `Uint8Array` for that reason -- a caller
 * handing over text would have had to encode it, and two ends encoding
 * differently is an identity that disagrees with itself.
 *
 * ## ONE function for every runtime, which is what makes a publication usable
 *
 * `etherfold build` names the fold it published with this, and a tab running the
 * published bundle names its generation with this, over the bytes it fetched
 * (ADR-0095). A snapshot is keyed to that name, so the two MUST agree, and the way
 * to make them agree by construction rather than by a test is to have one
 * definition. It is `viem`'s synchronous SHA-256 for the reason the seed path uses
 * it (`streamSeedContentHash`): it is already a dependency here, it runs in every
 * runtime, and it does not need the secure context `crypto.subtle` does, so a tab
 * served over plain HTTP on a LAN can still name what it runs.
 *
 * ## Why the algorithm travels in front of the digits
 *
 * This value is PASTED into builds, logs, generation records and publication
 * indexes, where it long outlives the session that produced it, and a bare hex
 * string cannot say which function produced it. `sha256:` is the prefix an OCI
 * image digest uses, and the one `streamSeedContentHash` renders.
 *
 * Note what it deliberately is NOT: a MINIFIED bundle is required for this to be
 * stable across machines, because un-minified esbuild output carries a per-module
 * path banner and therefore the building machine's directory layout. That rule
 * belongs to the documentation of the build command; what belongs here is that
 * this function hashes exactly what it is given and makes no attempt to normalise
 * it.
 *
 * There is deliberately NO predicate asking whether a string LOOKS like one:
 * `GenerationId.processor` is compared and rendered and NOTHING parses it
 * (ADR-0086), which is what lets a module arrival name its fold another way.
 */
export function processorArtifactIdentity(bundle: Uint8Array): string {
	return `sha256:${sha256(bundle).slice(2)}`;
}

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
 * a less precise refusal and nothing else, because a module instantiated from
 * bytes cannot LINK such a module anyway, so the loader still refuses the
 * artifact and merely says `unreadable-module` instead of naming the specifier. A
 * missed CALL would admit an artifact that fails at the first event it folds,
 * which is the failure this check exists to bring forward -- so that half stays
 * loose, and its price is that a bundle embedding `import("...")` inside a string
 * literal can be reported for an import that is not one.
 *
 * The clause is BOUNDED (rather than `*`) on purpose: a minified bundle is
 * frequently one line of several megabytes, and an unbounded run over it is how
 * a scan becomes the slowest thing in a start-up.
 */
const MODULE_REFERENCE =
	/(?:(?:^|[;}\r\n])\s*(?:import|export)\s*(?:[\w$*,{}\s]{0,512}?from\s*)?|(?:^|[^\w$.'"`])import\s*\(\s*)(['"])([^'"\n]*?)\1/g;

/**
 * EVERY MODULE A BUNDLE STILL NAMES, in the order it carries them and each named
 * once. Which of them a runtime can RESOLVE from bytes is that runtime's answer,
 * not this one's: Node resolves its builtins (`unresolvedImportsOf`,
 * `@etherfold/utils`, filters them out), and a browser resolves none, so there
 * every entry is an unresolved import.
 *
 * It reads TEXT and is not a parser, so what it can get wrong is bounded by where
 * each half of `MODULE_REFERENCE` is strict -- read it, because the asymmetry is
 * the argument. A bundle embedding JavaScript source in a string literal can be
 * reported for an import that is not one: the safe direction, since a refusal
 * names the specifier and the author can see exactly what was matched. A COMPUTED
 * dynamic specifier (`import(name)`) is invisible to it, as it would be to
 * anything static.
 */
export function moduleReferencesOf(bundle: Uint8Array): readonly string[] {
	const text = new TextDecoder().decode(bundle);
	const references: string[] = [];
	for (const match of text.matchAll(MODULE_REFERENCE)) {
		const specifier = match[2];
		if (specifier.length === 0 || references.includes(specifier)) {
			continue;
		}
		references.push(specifier);
	}
	return references;
}

/**
 * A processor module is whatever importing a processor yields. It may export a
 * `createProcessor` factory (function or already-built processor) plus contract
 * data via `contractsDataPerChain` (indexed by decimal chainId) and/or
 * `contractsData`.
 *
 * `createProcessor` is deliberately untyped here: what it hands back is the
 * AUTHORING object, and only the HOST knows which entity runtime is going to be
 * built around it (see `instantiateProcessor`). Typing it as one runtime's shape
 * here would make the module rule depend on that runtime.
 */
export type ProcessorModule<ABI extends Abi, ProcessResultType = unknown> = {
	createProcessor?: ((config?: any) => unknown) | object;
	contractsDataPerChain?: {[chainId: string]: AllContractData<ABI> | ContractData<ABI>[]};
	contractsData?: AllContractData<ABI> | ContractData<ABI>[];
	[key: string]: any;
};

export type InstantiateProcessorOptions = {
	/** What names the module in a message: a path, or the identity of an artifact that has none. */
	processorPath: string;
	/**
	 * Argument passed to the `createProcessor` factory. The CLI passes nothing; the
	 * server passes its `folder`. Making this an explicit parameter keeps the caller
	 * difference intentional rather than accidental. When omitted the factory is
	 * called with no args.
	 */
	processorConfig?: any;
};

/**
 * Call the module's `createProcessor` (or use it as-is when it is already an
 * object) and hand back whatever it produced, unread. Split out from
 * `instantiateProcessor` so the module-shape refusals -- and the exact no-arg
 * call the CLI has always made -- are readable on their own.
 */
function createFromModule<ABI extends Abi, ProcessResultType>(
	processorModule: ProcessorModule<ABI, ProcessResultType>,
	options: InstantiateProcessorOptions,
): unknown {
	const processorFactory = processorModule.createProcessor;

	if (!processorFactory) {
		throw new Error(
			`processor field could not be found: check module at ${options.processorPath} if it exports a "processor" field`,
		);
	}

	if (typeof processorFactory !== 'function') {
		return processorFactory;
	}

	// Pass processorConfig only when provided so the no-arg CLI call stays byte-identical.
	const created =
		'processorConfig' in options
			? (processorFactory as (config?: any) => unknown)(options.processorConfig)
			: (processorFactory as () => unknown)();

	if (!created) {
		throw new Error(
			`Processor could not be created, check the function exported as "processor" in module ${options.processorPath}`,
		);
	}

	return created;
}

/**
 * Resolve the `createProcessor` factory from the module and hand back what it
 * made: the AUTHORING object, declarations plus handlers.
 *
 *  - if `createProcessor` is a function, call it (with `processorConfig` if provided, else no args).
 *  - if `createProcessor` is already a processor object, use it as-is.
 *
 * Throws when no factory is found, when the factory produced nothing, and when
 * the module still carries the retired KIND TAG (below).
 *
 * What comes back is the authoring object and NOT an `EventProcessor`, because
 * WHERE the state lives is the deployment's choice: a module that picked a store
 * would have picked for every host that loads it. The host builds the runtime
 * (`new EntityEventProcessor(store, processor)`) around what this returns. It is
 * typed by the CALLER, through `EntityProcessorType`, so a host that owns an
 * entity runtime gets its own type at the wiring site while this package keeps
 * naming none of them; it defaults to `unknown`, the honest type for a caller
 * that has not said.
 *
 * It lives in core, beside the identity, because it is the ONE answer to "what is
 * a processor module" for every runtime that turns a module into a fold: the Node
 * loaders in `@etherfold/utils` and the browser's bundle arrival both ask it.
 */
export function instantiateProcessor<ABI extends Abi, ProcessResultType, EntityProcessorType = unknown>(
	processorModule: ProcessorModule<ABI, ProcessResultType>,
	options: InstantiateProcessorOptions,
): EntityProcessorType {
	const created = createFromModule<ABI, ProcessResultType>(processorModule, options);

	// The KIND TAG is gone with the kind it discriminated (ADR-0037): there is one
	// authoring path, so `{kind, processor}` names a choice that no longer exists.
	// Refused rather than unwrapped, because unwrapping it would keep a second
	// module shape alive forever -- and refused HERE, where the module can be named,
	// rather than three frames down where a store asks a wrapper for its `entities`
	// and gets `undefined`.
	if (typeof created === 'object' && created !== null && 'kind' in created) {
		throw new Error(
			`the processor module at ${options.processorPath} returns {kind: ${JSON.stringify(
				(created as {kind: unknown}).kind,
			)}, processor}, which was how a module said WHICH of two authoring paths it carried. There is one ` +
				`(ADR-0037): the free-form js-object path is deleted. Return the processor itself -- declarations plus ` +
				`handlers -- from "createProcessor".`,
		);
	}

	return created as EntityProcessorType;
}
