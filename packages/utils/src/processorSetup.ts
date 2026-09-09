import type {Abi, AllContractData, ContractData, IndexingSource} from '@etherfold/core';
import {createRequire} from 'node:module';
import path from 'node:path';
import {logs} from 'named-logs';

const logger = logs('@etherfold/utils:processorSetup');

// Minimal EIP-1193 provider surface this module needs (just `eth_chainId`). Kept structural so both
// the CLI's `JSONRPCHTTPProvider` and the server's provider satisfy it, and so tests can inject a
// fake without depending on `eip-1193`.
export type ChainIdProvider = {
	request(args: {method: 'eth_chainId'}): Promise<unknown>;
};

// A processor module is whatever `import()`-ing the processor path yields. It may export a
// `createProcessor` factory (function or already-built processor) plus contract data via
// `contractsDataPerChain` (indexed by decimal chainId) and/or `contractsData`.
//
// `createProcessor` is deliberately untyped here: what it hands back is the AUTHORING object, and
// only the HOST knows which entity runtime is going to be built around it (see
// `instantiateProcessor`). Typing it as one runtime's shape here would make this module loader
// depend on that runtime.
export type ProcessorModule<ABI extends Abi, ProcessResultType = unknown> = {
	createProcessor?: ((config?: any) => unknown) | object;
	contractsDataPerChain?: {[chainId: string]: AllContractData<ABI> | ContractData<ABI>[]};
	contractsData?: AllContractData<ABI> | ContractData<ABI>[];
	[key: string]: any;
};

// ---------------------------------------------------------------------------------------------------
// loadProcessorModule
// ---------------------------------------------------------------------------------------------------

export type LoadProcessorModuleOptions = {
	// Importer used to load the module. Defaults to the dynamic `import()`. Injectable for tests.
	importModule?: (specifier: string) => Promise<any>;
	// Module resolver used for the fallback (mirrors `createRequire(cwd/node_modules).resolve`).
	// Defaults to the real `createRequire` resolver. Injectable for tests.
	requireResolve?: (specifier: string) => string;
	// Working directory used to resolve relative paths. Defaults to `process.cwd()`.
	cwd?: string;
};

// Import the processor module by path. Behaviour (superset of the previous CLI/server copies):
//  - absolute path: imported directly.
//  - relative path: joined against `cwd` and imported; if that import fails, fall back to resolving
//    the specifier through `createRequire(cwd/node_modules).resolve(...)` (this is the server's
//    fallback, kept as the shared superset so a bare package specifier still resolves).
export async function loadProcessorModule<ABI extends Abi, ProcessResultType>(
	processorPath: string,
	options?: LoadProcessorModuleOptions,
): Promise<ProcessorModule<ABI, ProcessResultType>> {
	const cwd = options?.cwd ?? process.cwd();
	const importModule = options?.importModule ?? ((specifier: string) => import(specifier));
	const requireResolve =
		options?.requireResolve ?? ((specifier: string) => createRequire(`${cwd}/node_modules/`).resolve(specifier));

	if (path.isAbsolute(processorPath)) {
		return await importModule(processorPath);
	}

	try {
		return await importModule(path.join(cwd, processorPath));
	} catch (err) {
		// Fallback: resolve the specifier as a package/module name relative to cwd's node_modules.
		return await importModule(requireResolve(processorPath));
	}
}

// ---------------------------------------------------------------------------------------------------
// instantiateProcessor
// ---------------------------------------------------------------------------------------------------

export type InstantiateProcessorOptions = {
	// Path of the module, used only for error messages.
	processorPath: string;
	// Argument passed to the `createProcessor` factory. The CLI passes nothing; the server passes its
	// `folder`. Making this an explicit parameter keeps the caller difference intentional rather than
	// accidental (see MEDIUM-3 in the findings). When omitted the factory is called with no args.
	processorConfig?: any;
};

// Call the module's `createProcessor` (or use it as-is when it is already an object) and hand back
// whatever it produced, unread. Split out from `instantiateProcessor` so the module-shape refusals
// -- and the exact no-arg call the CLI has always made -- are readable on their own.
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

// ---------------------------------------------------------------------------------------------------
// resolveSource
// ---------------------------------------------------------------------------------------------------

// Resolve the indexing source (chainId + contracts) from a processor module, fetching `eth_chainId`
// only when `contractsDataPerChain` is present (preserving the original CLI/server behaviour where
// `contractsData`-only modules never triggered a chainId fetch).
//
// Resolution order:
//  1. if `contractsDataPerChain` exists, fetch chainId and try `contractsDataPerChain[chainId]`.
//  2. fall back to `contractsData`.
// Throws "no chainId found" when no chainId was determined, and "no contracts data found" when no
// contracts could be resolved.
export async function resolveSource<ABI extends Abi, ProcessResultType>(
	processorModule: ProcessorModule<ABI, ProcessResultType>,
	provider: ChainIdProvider,
): Promise<IndexingSource<ABI>> {
	let contractsData: AllContractData<ABI> | ContractData<ABI>[] | undefined;
	let chainIDAsDecimal: string | undefined;

	if (processorModule.contractsDataPerChain) {
		let chainIDAsHex: `0x${string}`;
		try {
			chainIDAsHex = (await provider.request({method: 'eth_chainId'})) as `0x${string}`;
		} catch (err) {
			// Use console.error (not the named-logs logger) so the diagnostic always reaches stderr. This
			// matches BOTH original callers exactly: the CLI does not wire `named-logs-console`, so a
			// `logger.error` here would be a silent no-op and lose the message.
			console.error(`could not fetch chainID`);
			throw err;
		}
		chainIDAsDecimal = '' + parseInt(chainIDAsHex.slice(2), 16);
		logger.info(processorModule.contractsDataPerChain);
		logger.info({chainIDAsHex, chainIDAsDecimal});
		contractsData = processorModule.contractsDataPerChain[chainIDAsDecimal];
	}
	if (!contractsData) {
		contractsData = processorModule.contractsData;
	}

	// `contractsData` is the per-chain map's FALLBACK, and it needs a chain id just as
	// much: the source it resolves to is `{chainId, contracts}`. Only the map's branch
	// used to ask for one, so a module exporting ONLY `contractsData` -- the shape the
	// docs describe as supported, and the one `--deployments` calls optional "where the
	// processor module supplies its own contract data" -- reached the refusal below and
	// threw `no chainId found` every time, on the CLI and the server alike.
	//
	// Asking here rather than at the top keeps the call conditional on NEEDING it: a
	// module that supplies neither still refuses without touching the chain.
	if (contractsData && !chainIDAsDecimal) {
		let chainIDAsHex: `0x${string}`;
		try {
			chainIDAsHex = (await provider.request({method: 'eth_chainId'})) as `0x${string}`;
		} catch (err) {
			// console.error for the same reason as above: the CLI wires no logger.
			console.error(`could not fetch chainID`);
			throw err;
		}
		chainIDAsDecimal = '' + parseInt(chainIDAsHex.slice(2), 16);
	}

	if (processorModule.contractsDataPerChain && !contractsData) {
		// console.error (not the named-logs logger) to match both original callers' stderr output.
		console.error(`field "contractsDataPerChain" found but no contracts data found for chainID: ${chainIDAsDecimal}`);
	}

	if (!chainIDAsDecimal) {
		throw new Error(`no chainId found`);
	}

	if (!contractsData) {
		throw new Error(`no contracts data found`);
	}

	return {
		chainId: chainIDAsDecimal,
		contracts: contractsData,
	};
}

// ---------------------------------------------------------------------------------------------------
// resolveProcessorAndSource — orchestration
// ---------------------------------------------------------------------------------------------------

export type ResolveProcessorAndSourceOptions<ABI extends Abi> = {
	// Path to the processor module (absolute or relative to `cwd`).
	processorPath: string;
	// Provider used to fetch `eth_chainId` when resolving the source from the module.
	provider: ChainIdProvider;
	// When provided, used as-is and no source is resolved from the module (the deployments path).
	source?: IndexingSource<ABI>;
	// Argument passed to the processor factory (see `instantiateProcessor`). Omit for the no-arg call.
	processorConfig?: any;
	// Module import collaborators (see `loadProcessorModule`). Injectable for tests.
	importModule?: (specifier: string) => Promise<any>;
	requireResolve?: (specifier: string) => string;
	cwd?: string;
};

export type ResolveProcessorAndSourceResult<ABI extends Abi, ProcessResultType, EntityProcessorType = unknown> = {
	processor: EntityProcessorType;
	processorModule: ProcessorModule<ABI, ProcessResultType>;
	source: IndexingSource<ABI>;
};

// Shared replacement for the near-identical processor/source setup previously copy-pasted in the CLI
// `init()` and the server `setupIndexing()`. Loads the module, instantiates the processor (with the
// explicit factory arg), and resolves the source (or uses the provided one). Returns the trio the
// callers need; each caller keeps owning provider construction, the store it folds into, caching and
// the engine instantiation.
export async function resolveProcessorAndSource<ABI extends Abi, ProcessResultType, EntityProcessorType = unknown>(
	options: ResolveProcessorAndSourceOptions<ABI>,
): Promise<ResolveProcessorAndSourceResult<ABI, ProcessResultType, EntityProcessorType>> {
	const processorModule = await loadProcessorModule<ABI, ProcessResultType>(options.processorPath, {
		importModule: options.importModule,
		requireResolve: options.requireResolve,
		cwd: options.cwd,
	});

	const processor = instantiateProcessor<ABI, ProcessResultType, EntityProcessorType>(
		processorModule,
		'processorConfig' in options
			? {processorPath: options.processorPath, processorConfig: options.processorConfig}
			: {processorPath: options.processorPath},
	);

	let source = options.source;
	if (!source) {
		source = await resolveSource<ABI, ProcessResultType>(processorModule, options.provider);
	}

	if (!source || !source.contracts) {
		throw new Error(
			`contracts data not found in the processor module, it needs to be provided either as exported field named "contractsData" or as field "contractsDataPerChain" indexed by chainID`,
		);
	}

	return {processor, processorModule, source};
}
