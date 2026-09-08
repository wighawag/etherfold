import type {EIP1193ProviderWithoutEvents} from 'eip-1193';

// ---------------------------------------------------------------------------
// THE ENGINE'S PROVIDER SURFACE, DECLARED ONCE
// ---------------------------------------------------------------------------
// ADR-0073 states the engine's whole chain-facing surface in one sentence, and
// ADR-0002 rests on it: a browser deployment talks EIP-1193 only, and the claim
// is worth something exactly to the extent that it is CHECKABLE. Deleting the
// enrichment path made the sentence true; this module is what keeps it true.
//
// The failure mode it exists to prevent is specific, and it is not a bug. A
// reintroduced per-block call RETURNS THE RIGHT ANSWER. It costs a round trip
// per block, against a provider a browser user is rate-limited on, and it would
// be found by a profiler months later rather than by CI in seconds -- so the
// guard cannot be a test of one function. It is one wrapper at the seam every
// call goes through, which is what makes it cheap.
// ---------------------------------------------------------------------------

/**
 * THE declared set. Stated HERE and nowhere else: a test carrying its own copy
 * of the list is a second source of truth, and the two drift the moment one of
 * them is edited.
 *
 * Four methods, one of which is the only DATA call:
 *
 * - `eth_getLogs` -- the fold's input, one call per range. The whole engine.
 * - `eth_blockNumber` -- the tip, once per cycle.
 * - `eth_chainId` -- the identity guard, at load and around each fetch.
 * - `eth_getBlockByNumber` -- the GENESIS PROBE, and only that (see
 *   `isGenesisProbe`): `IndexerGeneration` reads the chain's first block once at
 *   load to check the source's `genesisHash`, where one is declared and
 *   `skipGenesisCheck` is not set.
 *
 * The fourth is the one that is not in ADR-0073's sentence, and it is declared
 * rather than quietly exempted: it is IDENTITY, like `eth_chainId`, not data.
 * It is asked once per load, never per block, and never per event -- and the
 * guard holds it to that, because a method that reads A BLOCK is exactly the
 * shape a per-block cost comes back as.
 */
export const ENGINE_PROVIDER_METHODS = [
	'eth_getLogs',
	'eth_blockNumber',
	'eth_chainId',
	'eth_getBlockByNumber',
] as const;

/** One of the methods the engine is allowed to ask a provider for. */
export type EngineProviderMethod = (typeof ENGINE_PROVIDER_METHODS)[number];

const DECLARED: ReadonlySet<string> = new Set<string>(ENGINE_PROVIDER_METHODS);

/**
 * Whether a method is in the declared set at all.
 *
 * The predicate the guard below asks, exported because a caller wiring its own
 * proxy in front of the engine (a permission list, an allow-list on a gateway)
 * should be able to ask the engine rather than transcribe its answer.
 */
export function isEngineProviderMethod(method: string): method is EngineProviderMethod {
	return DECLARED.has(method);
}

/**
 * The two spellings of "the chain's first block", which is the only block the
 * engine ever names.
 *
 * `earliest` is what the load path asks for today. `0x0` is what
 * `work/tasks/ready/the-genesis-check-asks-for-block-zero-not-the-earliest-tag.md`
 * changes it to, because the tag means the lowest block the CLIENT HAS and that
 * is genesis only when the client has genesis. Both are accepted here so that
 * fix lands as the one-line change it is, and accepting both costs nothing that
 * matters: the property this predicate defends is that the read is of the
 * BOTTOM of the chain rather than of a block a log named, and both spellings
 * have it.
 */
const GENESIS_BLOCK_TAGS: ReadonlySet<unknown> = new Set(['earliest', '0x0']);

/**
 * Whether an `eth_getBlockByNumber` call is the genesis probe.
 *
 * The declared set is a set of METHOD NAMES, and for three of the four that is
 * the whole story. `eth_getBlockByNumber` is the exception, because the cost
 * this guard exists to prevent is a call PER BLOCK and this is the one declared
 * method that can express one: the genesis probe is a fixed question asked once
 * per load, and `['0x1f4', false]` is the reintroduced enrichment path wearing a
 * different method name.
 *
 * So the narrowing is not fussiness about parameters, it is the difference
 * between identity and data said in the only place it can be said.
 */
export function isGenesisProbe(params: unknown): boolean {
	return Array.isArray(params) && GENESIS_BLOCK_TAGS.has(params[0]);
}

/**
 * A provider asked for something outside the engine's declared surface.
 *
 * This is an INTERNAL invariant rather than an operator error: no configuration
 * and no node can provoke it, because the only code that reaches a guarded
 * provider is this engine. It is thrown rather than logged so that a
 * reintroduced call fails WHEREVER it is added, in the whole test suite, rather
 * than only where somebody thought to look -- a permissive test double would
 * otherwise answer it and the cost would ship.
 *
 * If a method genuinely belongs in the engine, the fix is to DECLARE it in
 * `ENGINE_PROVIDER_METHODS` (and say so in the README claim the tests hold to
 * it), never to route around the wrapper.
 */
export class UnexpectedProviderMethodError extends Error {
	readonly name = 'UnexpectedProviderMethodError';
	/** A provider does not stop being asked the wrong question while a caller waits. */
	readonly retryable = false;

	constructor(
		readonly method: string,
		reason: 'undeclared' | 'not-the-genesis-probe',
	) {
		super(
			reason === 'undeclared'
				? `the engine asked its provider for \`${method}\`, which is outside its declared surface ` +
						`(${ENGINE_PROVIDER_METHODS.join(', ')}). etherfold is a fold over logs and makes ONE data call ` +
						`(ADR-0073): a per-block or per-transaction request costs a round trip a browser deployment ` +
						`cannot afford. Declare the method in ENGINE_PROVIDER_METHODS if it truly belongs here.`
				: `the engine asked its provider for \`${method}\` at a specific block. The only block read the engine ` +
						`declares is the GENESIS PROBE (the chain's first block, once per load, to check genesisHash): a ` +
						`block read at any other height is a per-block cost, which is what ADR-0073 removed.`,
		);
	}
}

/**
 * A provider carrying the record of what it was asked for.
 *
 * The record is what a test drives the guard through: the assertion is that the
 * requested set is a SUBSET of the declared one, and a set that can be read is
 * what makes the assertion statable rather than inferred from a call count.
 */
export type MethodDeclaringProvider = EIP1193ProviderWithoutEvents & {
	/** Every method requested through this wrapper, refused ones included. */
	readonly methodsRequested: ReadonlySet<string>;
};

/** Wrappers this module made, so that wrapping twice is wrapping once. */
const guarded = new WeakSet<object>();

/**
 * The engine's ONE provider seam: every `request({method, params})` the engine
 * makes goes through here.
 *
 * It RECORDS the method (so a test can assert the subset directly) and REFUSES
 * anything outside the declared set (so the subset assertion is evaluated at
 * every call site in the suite rather than after the fact, in one test that
 * remembered to look).
 *
 * Idempotent: a provider that is already guarded is handed back as it is, so a
 * reconfigure that re-enters `reinit` does not stack wrappers.
 */
export function declaredMethodsOnly(provider: EIP1193ProviderWithoutEvents): MethodDeclaringProvider {
	if (guarded.has(provider)) {
		return provider as MethodDeclaringProvider;
	}
	const methodsRequested = new Set<string>();
	const wrapper = {
		methodsRequested: methodsRequested as ReadonlySet<string>,
		request(args: {method: string; params?: unknown}): Promise<unknown> {
			// recorded BEFORE the verdict: what the engine ASKED for is the fact a test
			// is after, and a refused call is the most interesting one there is.
			methodsRequested.add(args.method);
			if (!isEngineProviderMethod(args.method)) {
				return Promise.reject(new UnexpectedProviderMethodError(args.method, 'undeclared'));
			}
			if (args.method === 'eth_getBlockByNumber' && !isGenesisProbe(args.params)) {
				return Promise.reject(new UnexpectedProviderMethodError(args.method, 'not-the-genesis-probe'));
			}
			// `eip-1193` types `request` as an intersection of per-method overloads, so a
			// forwarding wrapper cannot be written in it. The cast is at this boundary,
			// once, and the object it produces is the narrower thing rather than the wider.
			return (provider as unknown as {request(args: unknown): Promise<unknown>}).request(args);
		},
	};
	guarded.add(wrapper);
	return wrapper as unknown as MethodDeclaringProvider;
}
