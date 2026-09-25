import type {Abi} from '@etherfold/core';
import {isAbsolute, join} from 'node:path';
import {loadProcessorArtifact, unresolvedImportsOf, type ProcessorArtifactOutcome} from './processorArtifact.js';
import {
	instantiateProcessor,
	loadProcessorModule,
	type LoadProcessorModuleOptions,
	type ProcessorModule,
} from './processorSetup.js';

// ---------------------------------------------------------------------------------------------------
// ONE PATH, TWO ARRIVALS, AND THE IDENTITY BELONGS TO THE ARRIVAL
// ---------------------------------------------------------------------------------------------------
// A PATH is still how a deployment names its processor and that does not change
// (ADR-0086). What changes is what the path points AT: a self-contained BUNDLE,
// which the runtime reads and hashes, rather than an entry point whose dependency
// closure is not captured. Nothing here bundles anything -- reading a file and
// hashing it is not bundling, and the CLI stays dumb -- and nothing here
// INTERPRETS the identity it produces.
//
// This module is the thing that was missing between the two arrivals already in
// this package: `processorSetup.ts` resolves a path through the MODULE SYSTEM,
// `processorArtifact.ts` turns BYTES into a processor and names them, and a host
// holding one operator-supplied path needs a single call that lands on whichever
// of the two that path describes.
//
// ## WHAT DECIDES, and why it is not a second heuristic
//
// A bundle is a module that expects NOBODY ELSE to resolve anything, and
// `unresolvedImportsOf` is this repository's only definition of that. It is the
// judgement the artifact loader refuses on, and it is the one the CLI's
// unbundled-path refusal refuses on. So it decides here too: bytes this process
// can read, with nothing left to resolve, ARE a bundle and are named by their
// hash; anything else -- a specifier that is not a readable file, a directory, an
// entry point that still imports its ABI -- takes the module route, and DERIVES NO
// IDENTITY AT ALL.
//
// The consequence worth stating rather than discovering: a hand-written entry
// point that happens to import NOTHING is a bundle by that definition, and is
// identified by its bytes. That is honest about what the file is, and the
// alternative -- a second, stricter test for "was this really produced by a
// bundler" -- would be two answers to one question.
//
// ## WHY THE MODULE ROUTE IS STILL HERE, with no identity to offer
//
// Because resolving a path through the module system is a separate capability
// from NAMING what came back, and this unit does the first. The author-declared
// identity the module route used to fall back on is gone, so a caller that gets
// an arrival with no `identity` has a fold it cannot name: the CLI REFUSES such a
// deployment, at configuration resolution and before it ever gets here
// (`refuseUnbundledProcessor`, `etherfold`), and a TEST that substituted
// the arrival states the bytes it stands for instead
// (`IndexingDependencies.processorBundle`). Refusing in here would take that
// second case with it, and would put a configuration decision in a loader.
// ---------------------------------------------------------------------------------------------------

/**
 * A PROCESSOR THAT HAS ARRIVED: what the author wrote, the module it came in, and
 * the identity the ARRIVAL derived -- where the arrival derives one at all.
 */
export type ProcessorArrival<ABI extends Abi, ProcessResultType, EntityProcessorType> = {
	/** The AUTHORING object the module's factory made: declarations plus handlers. */
	readonly processor: EntityProcessorType;
	/**
	 * The module itself, because a processor is not everything a deployment's entry
	 * point carries: `contractsData` / `contractsDataPerChain` ride on the module and
	 * resolving a source from them is the caller's step.
	 */
	readonly processorModule: ProcessorModule<ABI, ProcessResultType>;
	/**
	 * `sha256:<hex>` over the bundle's octets, where the path named a BUNDLE.
	 *
	 * ABSENT means the path named a module the module system resolved, which this
	 * unit can offer NO identity for -- there are no bytes that describe it and the
	 * declaration it used to fall back on is gone. Absent is a real answer rather
	 * than a missing value, which is why a caller reads it as "did the arrival supply
	 * one" and never as a string to inspect; what a caller does with the absence is
	 * its own (the CLI refuses such a path at configuration resolution, and a test
	 * that substituted the arrival states what it is called). Nothing in the tree
	 * parses `GenerationId.processor` (ADR-0086), and a helper asking whether an
	 * identity LOOKS like a hash would be the first thing to.
	 */
	readonly identity?: string;
	/**
	 * THE OCTETS `identity` was derived from: the bundle exactly as it was read,
	 * present exactly where `identity` is.
	 *
	 * Handed on rather than dropped once hashed, because a Node deployment STORES a
	 * generation's code beside its state (ADR-0092): what it stores has to be the very
	 * bytes that name the generation, and the only thing that holds them is the arrival
	 * that read them. Reading the path a second time to get them would be a second
	 * read that can disagree with the first -- a rebuild landing between the two would
	 * file one bundle's bytes under another's name.
	 */
	readonly bundle?: Uint8Array;
};

export type OpenProcessorArrivalOptions = LoadProcessorModuleOptions & {
	/**
	 * The argument handed to `createProcessor`. Omitted means the factory is called
	 * with NO arguments, which is the call the CLI has always made -- the same
	 * explicit distinction `instantiateProcessor` draws.
	 */
	processorConfig?: any;
	/**
	 * Read the bytes at a filesystem path. Defaults to `node:fs/promises`'s
	 * `readFile`, and a rejection of ANY kind means "this path does not name a file
	 * I can read", which is the module route's cue rather than a failure.
	 */
	readBundle?: (path: string) => Promise<Uint8Array>;
};

/**
 * WHAT A PROCESSOR PATH TURNS OUT TO BE: read it as bytes if it is a bundle,
 * resolve it through the module system if it is not, and hand back the same three
 * things either way -- plus, for a bundle, the bytes themselves.
 *
 * ## The ORDER, which is the part a caller depends on
 *
 * Everything here happens BEFORE a caller opens a database or registers anything,
 * and a refusal is a REJECTION with nothing done: no module is evaluated for a
 * bundle that is not self-contained, and a bundle that evaluated and carries no
 * processor has produced nothing to unwind. That is what lets a host say "a
 * processor that does not build leaves the deployment exactly as it was" and mean
 * it.
 *
 * ## Why an artifact REFUSAL becomes a throw here
 *
 * `loadProcessorArtifact` answers with DATA because bytes may arrive from a
 * request, where "these bytes are not a processor" is an ordinary thing for a host
 * to render. An OPERATOR-SUPPLIED PATH is not that: it is configuration, the
 * caller is a command that refuses bad configuration by raising, and the module
 * route beside it raises too. One shape for one input, with the artifact's own
 * `why` and its identity carried into the message so the refusal still names WHICH
 * bytes it refused.
 *
 * ## The injected collaborators, and what each governs
 *
 * `importModule` governs the MODULE arrival only: it is how a test states what
 * comes back for a specifier, and how a re-read defeats the ESM cache. It does
 * NOT reach the bundle arrival, which imports a `data:` URL of the bytes it just
 * read -- where the cache is keyed on those bytes and is therefore exactly right:
 * identical bytes ARE the same module. To state what the BYTES are, a caller
 * injects `readBundle` or writes a file.
 */
export async function openProcessorArrival<
	ABI extends Abi = Abi,
	ProcessResultType = unknown,
	EntityProcessorType = unknown,
>(
	processorPath: string,
	options: OpenProcessorArrivalOptions = {},
): Promise<ProcessorArrival<ABI, ProcessResultType, EntityProcessorType>> {
	const bundle = await bundleAt(processorPath, options);
	if (bundle) {
		const outcome = await loadProcessorArtifact<ABI, ProcessResultType, EntityProcessorType>(
			bundle,
			'processorConfig' in options ? {processorConfig: options.processorConfig} : {},
		);
		if (outcome.status === 'refused') throw refusedArtifact(processorPath, outcome);
		return {
			processor: outcome.processor,
			processorModule: outcome.processorModule,
			identity: outcome.identity,
			bundle,
		};
	}

	const processorModule = await loadProcessorModule<ABI, ProcessResultType>(processorPath, options);
	const processor = instantiateProcessor<ABI, ProcessResultType, EntityProcessorType>(
		processorModule,
		'processorConfig' in options ? {processorPath, processorConfig: options.processorConfig} : {processorPath},
	);
	return {processor, processorModule};
}

/**
 * WHAT IS AT A PROCESSOR PATH, as data, before anything is evaluated: the BUNDLE,
 * the ENTRY POINT it is instead, or nothing this process can read.
 *
 * Three cases rather than two, because two callers want different halves of the
 * same answer and neither should ask the question a second way. `bundleAt` below
 * needs only "bundle or not", since the answer to both other cases is the same
 * one: take the module route. A CONFIGURATION layer refusing the path needs to
 * say WHICH it met and WHAT is still unresolved, because a refusal reading "this
 * is not a bundle" is not actionable and one naming `./abi.js` is.
 */
export type ProcessorPathContents =
	| {readonly kind: 'bundle'; readonly bundle: Uint8Array}
	| {
			readonly kind: 'entry-point';
			readonly bundle: Uint8Array;
			/** Every module these bytes still expect somebody else to resolve, in the order they carry them. */
			readonly unresolvedImports: readonly string[];
	  }
	| {readonly kind: 'unreadable'; readonly why: string};

export type ReadProcessorPathOptions = Pick<OpenProcessorArrivalOptions, 'cwd' | 'readBundle'>;

/**
 * READ THE BYTES A PATH NAMES and say what they are, without importing anything.
 *
 * The path is resolved against `cwd` exactly as `loadProcessorModule` resolves a
 * relative specifier, and this is the ONE place that resolution is written for
 * the bundle arm, so an arrival and a caller that refuses the same path cannot
 * disagree about which file one `--processor ./dist/index.js` means.
 *
 * A rejection of any kind is `unreadable` rather than sniffed for `ENOENT`: the
 * question asked is "can I have these bytes", and a bare package specifier, a
 * directory and a build that has not run are all the same no. The reason travels
 * in `why` so a caller can render it.
 *
 * What decides between the other two is `unresolvedImportsOf`, which is this
 * repository's only definition of self-contained -- the same judgement the
 * artifact loader refuses on.
 */
export async function readProcessorPath(
	processorPath: string,
	options: ReadProcessorPathOptions = {},
): Promise<ProcessorPathContents> {
	const cwd = options.cwd ?? process.cwd();
	const path = isAbsolute(processorPath) ? processorPath : join(cwd, processorPath);
	const readBundle = options.readBundle ?? defaultReadBundle;
	let bundle: Uint8Array;
	try {
		bundle = await readBundle(path);
	} catch (error) {
		return {kind: 'unreadable', why: error instanceof Error ? error.message : String(error)};
	}
	const unresolvedImports = unresolvedImportsOf(bundle);
	return unresolvedImports.length === 0 ? {kind: 'bundle', bundle} : {kind: 'entry-point', bundle, unresolvedImports};
}

/**
 * The BUNDLE at this path, or nothing at all where the path does not name one.
 *
 * Two ways to be nothing and they are deliberately not distinguished HERE,
 * because the answer to both is the same: take the module route. The path may not
 * name a file this process can read (a bare package specifier, a directory, a
 * file that is not there), or the bytes may still expect somebody else to resolve
 * a module, in which case they are an ENTRY POINT rather than an artifact and
 * their dependency closure is not in them.
 */
async function bundleAt(processorPath: string, options: OpenProcessorArrivalOptions): Promise<Uint8Array | undefined> {
	const contents = await readProcessorPath(processorPath, options);
	return contents.kind === 'bundle' ? contents.bundle : undefined;
}

/** Imported lazily so that a host which never resolves a path never loads `node:fs`. */
async function defaultReadBundle(path: string): Promise<Uint8Array> {
	const {readFile} = await import('node:fs/promises');
	return readFile(path);
}

/**
 * The artifact's own refusal, as the error a configuration refusal is.
 *
 * It names the PATH the operator typed, the IDENTITY of the bytes at it and the
 * artifact unit's own `why`. The identity is there so that a refusal can be
 * correlated with the build that produced it, and it is RENDERED and never read:
 * an error message is one of the two things ADR-0086 says an identity is for.
 */
function refusedArtifact<ABI extends Abi, ProcessResultType, EntityProcessorType>(
	processorPath: string,
	outcome: Extract<ProcessorArtifactOutcome<ABI, ProcessResultType, EntityProcessorType>, {status: 'refused'}>,
): Error {
	return new Error(
		`the processor bundle at ${processorPath} (${outcome.identity}) was refused as ${outcome.reason}: ${outcome.why}`,
	);
}
