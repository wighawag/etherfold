import {describe, expect, it, vi} from 'vitest';
import type {Abi, ContractData} from '@etherfold/core';
import {
	loadProcessorModule,
	instantiateProcessor,
	resolveSource,
	resolveProcessorAndSource,
	type ProcessorModule,
} from '../src/processorSetup.js';

// ---------------------------------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------------------------------

// A fake EIP-1193 provider whose `eth_chainId` response is scripted (or throws).
function fakeProvider(opts: {chainIdHex?: `0x${string}`; throwOnChainId?: boolean} = {}) {
	const request = vi.fn(async (args: {method: string}) => {
		if (args.method === 'eth_chainId') {
			if (opts.throwOnChainId) {
				throw new Error('rpc down');
			}
			return opts.chainIdHex ?? '0x1';
		}
		throw new Error(`unexpected method ${args.method}`);
	});
	return {request} as any;
}

// A minimal processor object. Loose on purpose: this module hands back whatever the
// factory made, unread, because only the HOST knows which runtime is built around it.
function fakeProcessor(tag = 'p') {
	return {tag, version: '1.0.0', entities: []} as any;
}

const SAMPLE_CONTRACTS: ContractData<[]>[] = [{address: '0xabc', abi: [], startBlock: 1}];

/**
 * A processor module as `import()` actually delivers one: UNVALIDATED.
 *
 * `ProcessorModule` describes what a WELL-FORMED processor module looks like,
 * but `loadProcessorModule` gets its value from a dynamic `import()` of foreign
 * JS, so nothing checks it. `instantiateProcessor`'s guards exist exactly
 * because that shape can be a lie, and a case that exercises one of those guards
 * therefore has to build its module through the same unchecked door production
 * does, rather than as a well-typed literal that could never reach the guard.
 */
function asImported<ABI extends Abi, ProcessResultType>(mod: object): ProcessorModule<ABI, ProcessResultType> {
	return mod as ProcessorModule<ABI, ProcessResultType>;
}

// ---------------------------------------------------------------------------------------------------
// loadProcessorModule — module resolution (createRequire fallback is the superset behaviour)
// ---------------------------------------------------------------------------------------------------

describe('loadProcessorModule', () => {
	it('imports an absolute path directly (no cwd join, no fallback)', async () => {
		const mod = {createProcessor: () => fakeProcessor()};
		const importModule = vi.fn(async () => mod);
		const requireResolve = vi.fn();
		const result = await loadProcessorModule('/abs/path/processor.js', {
			importModule,
			requireResolve,
			cwd: '/some/cwd',
		});
		expect(result).toBe(mod);
		expect(importModule).toHaveBeenCalledTimes(1);
		expect(importModule).toHaveBeenCalledWith('/abs/path/processor.js');
		expect(requireResolve).not.toHaveBeenCalled();
	});

	it('joins a relative path against cwd', async () => {
		const mod = {createProcessor: () => fakeProcessor()};
		const importModule = vi.fn(async () => mod);
		const result = await loadProcessorModule('rel/processor.js', {
			importModule,
			cwd: '/some/cwd',
		});
		expect(result).toBe(mod);
		expect(importModule).toHaveBeenCalledWith('/some/cwd/rel/processor.js');
	});

	it('falls back to createRequire(...).resolve when the cwd-relative import fails', async () => {
		const mod = {createProcessor: () => fakeProcessor()};
		const importModule = vi.fn().mockRejectedValueOnce(new Error('Cannot find module')).mockResolvedValueOnce(mod);
		const requireResolve = vi.fn(() => '/resolved/node_modules/some-pkg/index.js');
		const result = await loadProcessorModule('some-pkg', {
			importModule,
			requireResolve,
			cwd: '/some/cwd',
		});
		expect(result).toBe(mod);
		expect(requireResolve).toHaveBeenCalledWith('some-pkg');
		expect(importModule).toHaveBeenNthCalledWith(1, '/some/cwd/some-pkg');
		expect(importModule).toHaveBeenNthCalledWith(2, '/resolved/node_modules/some-pkg/index.js');
	});
});

// ---------------------------------------------------------------------------------------------------
// instantiateProcessor — factory resolution + the explicit factory-arg parameter
// ---------------------------------------------------------------------------------------------------

describe('instantiateProcessor', () => {
	it('calls the factory and returns the processor', () => {
		const processor = fakeProcessor();
		const createProcessor = vi.fn(() => processor);
		const result = instantiateProcessor({createProcessor}, {processorPath: 'p.js'});
		expect(result).toBe(processor);
		expect(createProcessor).toHaveBeenCalledTimes(1);
	});

	it('passes processorConfig to the factory when provided (server behaviour)', () => {
		const processor = fakeProcessor();
		const createProcessor = vi.fn(() => processor);
		instantiateProcessor({createProcessor}, {processorPath: 'p.js', processorConfig: '/data/folder'});
		expect(createProcessor).toHaveBeenCalledWith('/data/folder');
	});

	it('calls the factory with no args when processorConfig is omitted (CLI behaviour)', () => {
		const processor = fakeProcessor();
		const createProcessor = vi.fn(() => processor);
		instantiateProcessor({createProcessor}, {processorPath: 'p.js'});
		expect(createProcessor).toHaveBeenCalledWith();
	});

	it('uses the factory directly when createProcessor is not a function', () => {
		const processor = fakeProcessor();
		const result = instantiateProcessor({createProcessor: processor}, {processorPath: 'p.js'});
		expect(result).toBe(processor);
	});

	it('throws when no createProcessor field is found', () => {
		expect(() => instantiateProcessor({}, {processorPath: 'p.js'})).toThrow(/could not be found/);
	});

	it('throws when the factory returns nothing', () => {
		const createProcessor = vi.fn(() => undefined);
		expect(() => instantiateProcessor(asImported({createProcessor}), {processorPath: 'p.js'})).toThrow(
			/could not be created/,
		);
	});
});

// ---------------------------------------------------------------------------------------------------
// resolveSource — contractsDataPerChain / contractsData / chainId fetch and the error cases
// ---------------------------------------------------------------------------------------------------

describe('resolveSource', () => {
	it('uses contractsDataPerChain[chainId] when present', async () => {
		const provider = fakeProvider({chainIdHex: '0x1'});
		const processorModule = {contractsDataPerChain: {'1': SAMPLE_CONTRACTS}};
		const source = await resolveSource(processorModule, provider);
		expect(source).toEqual({chainId: '1', contracts: SAMPLE_CONTRACTS});
		expect(provider.request).toHaveBeenCalledWith({method: 'eth_chainId'});
	});

	it('falls back to contractsData when contractsDataPerChain has no entry for the chain', async () => {
		const provider = fakeProvider({chainIdHex: '0x1'});
		const processorModule = {
			contractsDataPerChain: {'137': SAMPLE_CONTRACTS},
			contractsData: SAMPLE_CONTRACTS,
		};
		const source = await resolveSource(processorModule, provider);
		expect(source).toEqual({chainId: '1', contracts: SAMPLE_CONTRACTS});
	});

	// This USED to throw `no chainId found`, and was characterized as "quirky, but
	// preserved exactly" when this resolver was extracted. It was not a quirk, it was a
	// dead path: `contractsData` is documented as the per-chain map's fallback, and
	// `--deployments` calls itself optional "where the processor module supplies its own
	// contract data", so the supported shape always threw. It now asks the chain for the
	// id it needs, which is the same one call the map's branch makes.
	it('fetches the chainId for a module exporting only contractsData', async () => {
		const provider = fakeProvider({chainIdHex: '0x1'});
		const processorModule = {contractsData: SAMPLE_CONTRACTS};
		const source = await resolveSource(processorModule, provider);
		expect(source).toEqual({chainId: '1', contracts: SAMPLE_CONTRACTS});
		expect(provider.request).toHaveBeenCalledWith({method: 'eth_chainId'});
	});

	it('asks the chain NOTHING when the module supplies no contract data at all', async () => {
		// the refusal below is reached without a round trip: there is nothing to resolve,
		// so a chain id would not help
		const provider = fakeProvider({chainIdHex: '0x1'});
		await expect(resolveSource({contractsData: undefined}, provider)).rejects.toThrow(/no chainId found/);
		expect(provider.request).not.toHaveBeenCalled();
	});

	it('throws "no chainId found" when chainId could not be determined and contractsData is missing', async () => {
		const provider = fakeProvider();
		const processorModule = {contractsData: undefined};
		await expect(resolveSource(processorModule, provider)).rejects.toThrow(/no chainId found/);
	});

	it('throws "no contracts data found" (and logs to stderr) when chainId is known but no contracts resolved', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const provider = fakeProvider({chainIdHex: '0x1'});
		const processorModule = {contractsDataPerChain: {'137': SAMPLE_CONTRACTS}}; // no entry for 1, no contractsData
		await expect(resolveSource(processorModule, provider)).rejects.toThrow(/no contracts data found/);
		// Original callers emitted this diagnostic via console.error (not the named-logs logger, which is
		// a silent no-op in the CLI). Preserve that.
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('contractsDataPerChain'));
		errSpy.mockRestore();
	});

	it('propagates the error (and logs to stderr) when eth_chainId fetch fails', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const provider = fakeProvider({throwOnChainId: true});
		const processorModule = {contractsDataPerChain: {'1': SAMPLE_CONTRACTS}};
		await expect(resolveSource(processorModule, provider)).rejects.toThrow(/rpc down/);
		expect(errSpy).toHaveBeenCalledWith('could not fetch chainID');
		errSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------------------------------
// resolveProcessorAndSource — end-to-end orchestration
// ---------------------------------------------------------------------------------------------------

describe('resolveProcessorAndSource', () => {
	it('loads the module, instantiates the processor (no factory arg — CLI behaviour) and resolves the source', async () => {
		const processor = fakeProcessor();
		const createProcessor = vi.fn(() => processor);
		const mod = {
			createProcessor,
			contractsDataPerChain: {'1': SAMPLE_CONTRACTS},
		};
		const importModule = vi.fn(async () => mod);
		const provider = fakeProvider({chainIdHex: '0x1'});
		const result = await resolveProcessorAndSource({
			processorPath: '/abs/p.js',
			provider,
			importModule,
			// processorConfig intentionally omitted (CLI): factory must be called with ZERO args, not
			// `undefined`, so the orchestration must not turn an absent key into `createProcessor(undefined)`.
		});
		expect(result.processor).toBe(processor);
		expect(result.processorModule).toBe(mod);
		expect(result.source).toEqual({chainId: '1', contracts: SAMPLE_CONTRACTS});
		expect(createProcessor).toHaveBeenCalledWith(); // zero args
	});

	it('uses a provided source (deployments path) without fetching chainId', async () => {
		const processor = fakeProcessor();
		const mod = {createProcessor: vi.fn(() => processor)};
		const importModule = vi.fn(async () => mod);
		const provider = fakeProvider();
		const providedSource = {chainId: '1', contracts: SAMPLE_CONTRACTS};
		const result = await resolveProcessorAndSource({
			processorPath: '/abs/p.js',
			provider,
			importModule,
			source: providedSource as any,
		});
		expect(result.source).toBe(providedSource);
		expect(provider.request).not.toHaveBeenCalled();
	});

	it('passes processorConfig through to the factory', async () => {
		const processor = fakeProcessor();
		const createProcessor = vi.fn(() => processor);
		const mod = {createProcessor, contractsData: SAMPLE_CONTRACTS};
		const importModule = vi.fn(async () => mod);
		const provider = fakeProvider({chainIdHex: '0x1'});
		await resolveProcessorAndSource({
			processorPath: '/abs/p.js',
			provider,
			importModule,
			processorConfig: '/folder',
			source: {chainId: '1', contracts: SAMPLE_CONTRACTS} as any,
		});
		expect(createProcessor).toHaveBeenCalledWith('/folder');
	});
});
