import {
	instantiateProcessor,
	moduleReferencesOf,
	processorArtifactIdentity,
	type Abi,
	type ProcessorModule,
} from '@etherfold/core';

/**
 * THE BUNDLE ARRIVAL: a tab runs the processor bundle a build PUBLISHED, and
 * names its generation by the SHA-256 of those very bytes (ADR-0086, ADR-0095).
 *
 * It is the browser counterpart of `loadProcessorArtifact` (`@etherfold/utils`):
 * fetch the bytes, hash them, establish that they are self-contained, and only
 * then instantiate FROM THOSE BYTES. The identity and the checks are
 * `@etherfold/core`'s (`processorArtifactIdentity`, `moduleReferencesOf`,
 * `instantiateProcessor`), the same functions the CLI names its published fold
 * with, so a tab running the published bundle derives the publisher's identity by
 * construction and finds the snapshot keyed to it.
 *
 * ## WHY THE TAB FETCHES AND HASHES, rather than being told a hash
 *
 * A build step COULD inject the bundle's hash into a tab running the module its
 * own bundler compiled. ADR-0095 refuses that: the identity would name bytes the
 * tab does not run, which is the lie ADR-0086 removes. So nothing here accepts an
 * identity, and the one it reports is computed over the octets that are then
 * instantiated. There is exactly ONE fetch: the bytes that are hashed are the
 * bytes that are imported, never a second download of the same URL that a CDN
 * might answer differently.
 *
 * ## WHY FROM BYTES, and what that costs under a Content-Security-Policy
 *
 * Importing the URL itself would be a second fetch (above), so the bytes are
 * imported through a URL MADE OF them: a `data:` URL first, then a `blob:` one.
 * A browser can do that, subject to the page's (or the worker script's own)
 * Content-Security-Policy: `script-src 'self'` refuses both, and so do some IPFS
 * gateways' headers (`work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md`,
 * where `data:` and `blob:` are measured as separate source expressions, neither
 * a superset of the other, which is why both are tried). A refusal by policy is
 * REPORTED, as `forbidden-by-policy`, naming the policy; it is never a stall and
 * never mistaken for damaged bytes.
 *
 * Telling the two apart is the subtle part, because under a blocking policy good
 * bytes and corrupt bytes reject with the IDENTICAL error (the block happens
 * before anything is parsed). So each scheme is first PROBED with a module that
 * cannot fail on its own merits: the probe decides whether this context may
 * instantiate from bytes at all, and only once one has passed are the real bytes
 * imported, so any failure after that is the bytes' own. Whatever
 * `securitypolicyviolation` events fired during the probes are what name the
 * directive and the policy in the refusal.
 *
 * ## WHERE it runs
 *
 * Anywhere a tab folds: on the main thread and inside a dedicated or shared
 * worker, where the processor is instantiated INSIDE the worker, because a
 * processor is code and cannot cross a port (ADR-0082). A host given a
 * `processorBundle` (`BrowserGenerationSpec`) calls this itself; an app may also
 * call it directly, as the CLI calls `loadProcessorArtifact`.
 */

/** Where a published bundle is fetched from. A relative URL resolves against the context's own location. */
export type ProcessorBundleLocation = string | URL;

export type LoadProcessorBundleOptions = {
	/** Injectable for tests and for a host with its own retry or timeout policy. Defaults to the global `fetch`. */
	fetch?: typeof globalThis.fetch;
	/**
	 * HOW A URL MADE OF THE BYTES BECOMES A MODULE. Defaults to the dynamic
	 * `import()`, which is the only thing a deployment should use.
	 *
	 * Injectable for the same reason `loadProcessorModule`'s importer is: a test
	 * has no Content-Security-Policy to be refused by, and this is the one step a
	 * policy acts on. Whatever it is handed is a `data:` or `blob:` URL of the very
	 * bytes that were hashed, so replacing it cannot make the identity name
	 * anything but what runs.
	 */
	importModule?: (url: string) => Promise<unknown>;
};

/**
 * WHY a published bundle was not instantiated. Data, so a host can render it and
 * a caller can branch on it; each has a different remedy.
 */
export type ProcessorBundleRefusalReason =
	/** The bytes never arrived: the fetch failed or the server did not answer `2xx`. There is nothing to name. */
	| 'unreachable'
	/** The bundle still imports a module, which nothing can resolve for a module made of bytes (ADR-0085). */
	| 'not-self-contained'
	/** The bytes did not become a module: they do not parse as ESM, or the module's top-level code threw. */
	| 'unreadable-module'
	/** The module evaluated and carries no processor (see `instantiateProcessor`). */
	| 'not-a-processor'
	/**
	 * THIS CONTEXT MAY NOT INSTANTIATE A MODULE FROM BYTES: its
	 * Content-Security-Policy refused both a `data:` and a `blob:` module. Not a
	 * fault of the bundle, and not something a retry changes: the policy is the
	 * page's (or the worker script's response's), and an app can only loosen it
	 * where it is the one sending it.
	 */
	| 'forbidden-by-policy';

/** What a `securitypolicyviolation` event said about a refused probe, where one fired. */
export type ProcessorBundlePolicyViolation = {
	/** The directive that refused it (`script-src`, `script-src-elem`, ...). */
	readonly directive: string;
	/** What was refused, as the event reports it (`data`, `blob`). */
	readonly blocked: string;
	/** The policy, verbatim. */
	readonly policy: string;
};

/** A bundle that became a processor: the identity of its bytes, and what they made. */
export type InstantiatedProcessorBundle<EntityProcessorType = unknown> = {
	readonly status: 'instantiated';
	/** Where the bytes were fetched from, as given. */
	readonly location: string;
	/** `sha256:<hex>` over the fetched octets: what `etherfold build` names the same file. */
	readonly identity: string;
	/**
	 * The AUTHORING object the bundle's factory made: declarations plus handlers.
	 * `unknown` unless the caller says otherwise, because what bytes fetched at run
	 * time contain is not something a type checker saw.
	 */
	readonly processor: EntityProcessorType;
	/** The module itself: `contractsData` and `contractsDataPerChain` ride on it. */
	readonly processorModule: ProcessorModule<Abi>;
};

export type RefusedProcessorBundle =
	| {
			readonly status: 'refused';
			readonly location: string;
			readonly reason: 'unreachable';
			readonly why: string;
	  }
	| {
			readonly status: 'refused';
			readonly location: string;
			readonly identity: string;
			readonly reason: 'not-self-contained';
			readonly why: string;
			/** Every module this bundle still names. In a browser none of them resolves. */
			readonly unresolvedImports: readonly string[];
	  }
	| {
			readonly status: 'refused';
			readonly location: string;
			readonly identity: string;
			readonly reason: 'unreadable-module' | 'not-a-processor';
			readonly why: string;
	  }
	| {
			readonly status: 'refused';
			readonly location: string;
			readonly identity: string;
			readonly reason: 'forbidden-by-policy';
			readonly why: string;
			/** What the context reported about each refusal, where it reported anything. */
			readonly violations: readonly ProcessorBundlePolicyViolation[];
	  };

/**
 * WHAT A LOAD DID, as data. Nothing here throws for an ordinary condition: a URL
 * that does not answer, bytes that are not a processor and a policy that forbids
 * them are all ordinary for code that arrives over the network.
 */
export type ProcessorBundleOutcome<EntityProcessorType = unknown> =
	| InstantiatedProcessorBundle<EntityProcessorType>
	| RefusedProcessorBundle;

/**
 * FETCH A PUBLISHED BUNDLE, NAME IT BY ITS BYTES, AND INSTANTIATE IT FROM THEM.
 *
 * The order is `loadProcessorArtifact`'s and for its reason: everything checkable
 * happens BEFORE evaluation, which is the irreversible act (the module joins this
 * context's registry for its lifetime and its top-level code runs). So a bundle
 * that still imports something is refused against its bytes and never evaluated.
 *
 * ```ts
 * const bundle = await loadProcessorBundle<EntityProcessor<MyAbi>>('/processor.bundle.js');
 * if (bundle.status === 'refused') return render(bundle.why);
 * // bundle.identity is the generation's processor identity, and nothing parses it.
 * ```
 *
 * The factory is called with NO arguments, as the CLI calls it: a processor's own
 * configuration is applied by the host through `configure` (`processorConfig`).
 */
export async function loadProcessorBundle<EntityProcessorType = unknown>(
	location: ProcessorBundleLocation,
	options?: LoadProcessorBundleOptions,
): Promise<ProcessorBundleOutcome<EntityProcessorType>> {
	const named = String(location);
	const fetched = await fetchBytes(location, options?.fetch ?? globalThis.fetch);
	if (typeof fetched === 'string') {
		return {
			status: 'refused',
			location: named,
			reason: 'unreachable',
			why: `the processor bundle at ${named} could not be fetched: ${fetched}`,
		};
	}
	const bundle = fetched;
	const identity = processorArtifactIdentity(bundle);

	// A module made of bytes has no base URL and no module resolution at all, so in
	// a browser EVERY specifier it still names is unresolved (Node resolves its
	// builtins; nothing here does).
	const unresolvedImports = moduleReferencesOf(bundle);
	if (unresolvedImports.length > 0) {
		return {
			status: 'refused',
			location: named,
			identity,
			reason: 'not-self-contained',
			unresolvedImports,
			why:
				`the processor bundle at ${named} still imports ${unresolvedImports.map((specifier) => JSON.stringify(specifier)).join(', ')}, ` +
				`which nothing can resolve for it: it is instantiated from its own bytes, with no URL to resolve a path ` +
				`against. Bundle the processor into ONE self-contained module (ADR-0085), the way \`etherfold build\` ` +
				`is pointed at it.`,
		};
	}

	const importModule = options?.importModule ?? ((url: string) => import(/* @vite-ignore */ url));
	const permitted = await aSchemeThisContextMayImport(importModule);
	if (permitted.status === 'forbidden') {
		const namedPolicies = permitted.violations.map(
			(violation) => `\`${violation.directive}\` refused \`${violation.blocked}\` under "${violation.policy}"`,
		);
		return {
			status: 'refused',
			location: named,
			identity,
			reason: 'forbidden-by-policy',
			violations: permitted.violations,
			why:
				`this context's Content-Security-Policy forbids instantiating a module from bytes, so the processor bundle ` +
				`at ${named} cannot run here: it refused both a \`data:\` and a \`blob:\` module` +
				(namedPolicies.length > 0 ? ` (${namedPolicies.join('; ')})` : '') +
				`. The bytes were not at fault. A worker's policy is its own script response's, not the page's. To run ` +
				`a published bundle, the policy that applies must allow \`blob:\` or \`data:\` in \`script-src\` (or use ` +
				`\`'strict-dynamic'\`).`,
		};
	}

	let processorModule: ProcessorModule<Abi>;
	try {
		processorModule = (await permitted.importBytes(bundle)) as ProcessorModule<Abi>;
	} catch (error) {
		return {
			status: 'refused',
			location: named,
			identity,
			reason: 'unreadable-module',
			why: `the processor bundle at ${named} did not become a module: ${messageOf(error)}`,
		};
	}

	try {
		const processor = instantiateProcessor<Abi, unknown, EntityProcessorType>(processorModule, {
			processorPath: `${named} (${identity})`,
		});
		return {status: 'instantiated', location: named, identity, processor, processorModule};
	} catch (error) {
		return {
			status: 'refused',
			location: named,
			identity,
			reason: 'not-a-processor',
			why: `the processor bundle at ${named} evaluated but carries no processor: ${messageOf(error)}`,
		};
	}
}

/**
 * A REFUSED BUNDLE, AS A HOST RAISES IT: the refusal's own fields on an `Error`
 * whose `name` a tab narrows on, since a failure crosses a port by name and by its
 * own enumerable fields (`PortError`).
 *
 * A host raises this where it was given a `processorBundle` and the load was
 * refused, BEFORE it builds the generation's state, so a refused bundle claims no
 * store and folds nothing.
 */
export class ProcessorBundleRefusedError extends Error {
	readonly reason: ProcessorBundleRefusalReason;
	readonly location: string;
	readonly identity?: string;
	readonly unresolvedImports?: readonly string[];
	readonly violations?: readonly ProcessorBundlePolicyViolation[];

	constructor(refusal: RefusedProcessorBundle) {
		super(refusal.why);
		this.name = 'ProcessorBundleRefusedError';
		this.reason = refusal.reason;
		this.location = refusal.location;
		if ('identity' in refusal) this.identity = refusal.identity;
		if ('unresolvedImports' in refusal) this.unresolvedImports = refusal.unresolvedImports;
		if ('violations' in refusal) this.violations = refusal.violations;
	}
}

/** Where a host fetches its generation's processor from (`BrowserGenerationSpec.processorBundle`). */
export type ProcessorBundleSource = LoadProcessorBundleOptions & {
	/** The published bundle: the very file `etherfold build --publish` folded with. */
	readonly url: ProcessorBundleLocation;
};

/**
 * ONE LOAD PER SOURCE for the life of the page (or worker), shared by every
 * generation a host builds from the same `processorBundle` object.
 *
 * A host builds a spec's generation more than once: a reconfigure across the port
 * adds a generation over a new source with the SAME spec. Fetching again there
 * would let a redeploy swap the processor underneath a change that only asked for
 * a new source, so the first instantiated bundle is what that spec runs. A
 * REFUSAL is not kept, so a later attempt (a new `init` after `dispose`) fetches
 * again rather than inheriting a failure that may have been transient.
 */
const arrivals = new WeakMap<ProcessorBundleSource, Promise<InstantiatedProcessorBundle>>();

/** @internal The hosts' entry point: the instantiated bundle, or a raised `ProcessorBundleRefusedError`. */
export function arriveFromBundle(source: ProcessorBundleSource): Promise<InstantiatedProcessorBundle> {
	let arrival = arrivals.get(source);
	if (!arrival) {
		arrival = loadProcessorBundle(source.url, source).then((outcome) => {
			if (outcome.status === 'refused') {
				arrivals.delete(source);
				throw new ProcessorBundleRefusedError(outcome);
			}
			return outcome;
		});
		arrivals.set(source, arrival);
	}
	return arrival;
}

/**
 * @internal A spec that names a bundle AND an identity is a wiring mistake in the
 * app's own source, raised where the spec is built rather than reported as a
 * refusal: the identity of a bundle is the hash of the bytes that run (ADR-0095),
 * so an identity supplied beside one is either redundant or a lie, and nothing
 * can tell which.
 */
export function refuseAnIdentityBesideABundle(
	arrival: {processorIdentity?: string; processorBundle?: ProcessorBundleSource} | undefined,
): void {
	if (arrival?.processorBundle && arrival.processorIdentity !== undefined) {
		throw new Error(
			`this generation names a \`processorBundle\` AND a \`processorIdentity\`: a published bundle is named by the ` +
				`SHA-256 of the bytes the tab fetches and runs, so an identity supplied beside it would name bytes this tab ` +
				`did not hash (ADR-0095). Drop \`processorIdentity\`.`,
		);
	}
}

/** The bytes, or why there are none. One fetch: these are the bytes that are hashed AND imported. */
async function fetchBytes(
	location: ProcessorBundleLocation,
	fetchImpl: typeof globalThis.fetch | undefined,
): Promise<Uint8Array | string> {
	if (typeof fetchImpl !== 'function') return `this context has no \`fetch\``;
	try {
		const base = (globalThis as {location?: {href?: string}}).location?.href;
		const url = base === undefined ? new URL(location) : new URL(location, base);
		const response = await fetchImpl(url);
		if (!response.ok) return `the server answered ${response.status} ${response.statusText}`.trimEnd();
		return new Uint8Array(await response.arrayBuffer());
	} catch (error) {
		return messageOf(error);
	}
}

/** A module that cannot fail on its own merits: if it is refused, the SCHEME was. */
const PROBE = new TextEncoder().encode('export default 1;');

type PermittedScheme =
	| {status: 'permitted'; importBytes: (bytes: Uint8Array) => Promise<unknown>}
	| {status: 'forbidden'; violations: ProcessorBundlePolicyViolation[]};

/**
 * WHICH WAY OF MAKING A MODULE FROM BYTES THIS CONTEXT ALLOWS: `data:` first
 * (every runtime this package is tested in can import one), then `blob:`.
 *
 * Decided by PROBING rather than by reading the error the real import throws,
 * because under a blocking policy that error is identical for good and corrupt
 * bytes (see the module note). The `securitypolicyviolation` events are listened
 * for only to NAME the policy, and are read after a macrotask, since a violation
 * is dispatched as a task of its own and may land after the rejected import.
 */
async function aSchemeThisContextMayImport(importModule: (url: string) => Promise<unknown>): Promise<PermittedScheme> {
	const violations: ProcessorBundlePolicyViolation[] = [];
	const scope = globalThis as {
		addEventListener?: (type: string, listener: (event: unknown) => void) => void;
		removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
	};
	const onViolation = (event: unknown) => {
		const violation = event as {effectiveDirective?: string; blockedURI?: string; originalPolicy?: string};
		violations.push({
			directive: violation.effectiveDirective ?? 'unknown',
			blocked: violation.blockedURI ?? 'unknown',
			policy: violation.originalPolicy ?? 'unknown',
		});
	};
	scope.addEventListener?.('securitypolicyviolation', onViolation);
	try {
		for (const importBytes of [
			(bytes: Uint8Array) => importModule(dataUrlOf(bytes)),
			(bytes: Uint8Array) => importThroughBlob(bytes, importModule),
		]) {
			try {
				await importBytes(PROBE);
				return {status: 'permitted', importBytes};
			} catch {
				// This scheme is refused here; the next one may not be.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		return {status: 'forbidden', violations: [...violations]};
	} finally {
		scope.removeEventListener?.('securitypolicyviolation', onViolation);
	}
}

/**
 * The bytes as a `data:` module URL, base64 because a bundle is arbitrary
 * JavaScript and `,` or `#` would end a plain payload. Not part of the identity,
 * which is over the octets.
 */
function dataUrlOf(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunk) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
	}
	return `data:text/javascript;base64,${btoa(binary)}`;
}

/** The bytes as a `blob:` module URL, released once the import has settled. */
async function importThroughBlob(bytes: Uint8Array, importModule: (url: string) => Promise<unknown>): Promise<unknown> {
	if (typeof URL.createObjectURL !== 'function') {
		throw new Error(`this context cannot make a \`blob:\` URL`);
	}
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], {type: 'text/javascript'}));
	try {
		return await importModule(url);
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** What went wrong, in words, for the `why` a caller renders. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
