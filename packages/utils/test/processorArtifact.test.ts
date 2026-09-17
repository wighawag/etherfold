import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import type {Abi} from '@etherfold/core';
import {loadProcessorArtifact, processorArtifactIdentity, unresolvedImportsOf} from '../src/processorArtifact.js';
import {
	createProcessor as createProcessorFromSource,
	type Mutations,
	type TransferEvent,
} from './fixtures/processor-artifact/source/processor.js';

// ---------------------------------------------------------------------------------------------------
// A PROCESSOR ARTIFACT: BYTES, THE IDENTITY DERIVED FROM THEM, AND A LOADER
// ---------------------------------------------------------------------------------------------------
// An author cannot STATE a processor's identity (ADR-0086): a bundle IS the
// processor and the hash of its octets IS its name. These three capabilities are
// what every later task in that family rests on -- hash, admit, instantiate --
// and NOTHING consumes them yet, which is why nothing here stands up a
// deployment.
//
// The seam is the unit plus the COMMITTED fixture. A hand-written string can be
// made to pass any check written beside it; only a bundle produced by the
// documented command (`esbuild --bundle --format=esm --minify`, see the
// fixture's README) exercises what a deployment actually hands over.
// ---------------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_BUNDLE = join(here, 'fixtures/processor-artifact/processor.bundle.js');

/** The committed artifact, read as OCTETS, because that is what an identity is over. */
function theCommittedBundle(): Uint8Array {
	return new Uint8Array(readFileSync(FIXTURE_BUNDLE));
}

/** Bytes assembled in memory: no file, which is how the no-filesystem claim is asserted. */
function bytesOf(source: string): Uint8Array {
	return new TextEncoder().encode(source);
}

/** What a processor did, recorded by standing in for the store it writes through. */
function foldATransfer(processor: {onTransfer: (state: Mutations, event: TransferEvent) => void}) {
	const written: {entity: string; id: string; values: {readonly [field: string]: unknown}}[] = [];
	const state: Mutations = {
		set(entity, id, values) {
			written.push({entity, id, values});
		},
	};
	processor.onTransfer(state, {args: {to: '0xf00', tokenID: 42n}});
	return written;
}

/** The shape the fixture's bundle hands back, so the round trip is typed rather than cast. */
type FixtureProcessor = {
	entities: unknown[];
	onTransfer: (state: Mutations, event: TransferEvent) => void;
};

// ---------------------------------------------------------------------------------------------------
// processorArtifactIdentity -- bytes carry their own name
// ---------------------------------------------------------------------------------------------------

describe('processorArtifactIdentity', () => {
	it('renders SHA-256 over the octets as `sha256:<64 lowercase hex>`', () => {
		expect(processorArtifactIdentity(theCommittedBundle())).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it('is the known SHA-256 of what it was given, so the domain is the octets and nothing else', () => {
		// The published vector for the empty input. It pins the BYTE DOMAIN: a
		// function hashing a decoded string, a JSON re-serialisation or a
		// base64 rendering would not land here.
		expect(processorArtifactIdentity(new Uint8Array())).toBe(
			'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
	});

	it('gives identical bytes an identical identity, however they were obtained', () => {
		expect(processorArtifactIdentity(theCommittedBundle())).toBe(
			processorArtifactIdentity(bytesOf(readFileSync(FIXTURE_BUNDLE, 'utf-8'))),
		);
	});

	it('moves on one changed byte, which is the whole property the family exists for', () => {
		const identity = processorArtifactIdentity(bytesOf('export const createProcessor = () => ({a: 1});'));
		const edited = processorArtifactIdentity(bytesOf('export const createProcessor = () => ({a: 2});'));
		expect(edited).not.toBe(identity);
	});
});

// ---------------------------------------------------------------------------------------------------
// unresolvedImportsOf -- self-contained is CHECKED, not promised
// ---------------------------------------------------------------------------------------------------

describe('unresolvedImportsOf', () => {
	it('admits the committed bundle, whose sibling import the bundler inlined', () => {
		expect(unresolvedImportsOf(theCommittedBundle())).toEqual([]);
	});

	it('names a bare specifier a static import still carries', () => {
		expect(unresolvedImportsOf(bytesOf('import{createPublicClient}from"viem";export const a=1;'))).toEqual(['viem']);
	});

	it('names a bare specifier imported for its side effects alone', () => {
		expect(unresolvedImportsOf(bytesOf('import"viem";export const a=1;'))).toEqual(['viem']);
	});

	it('names a bare specifier a re-export carries', () => {
		expect(unresolvedImportsOf(bytesOf('export*from"viem";'))).toEqual(['viem']);
	});

	it('names a RELATIVE specifier too: a `data:` URL is not a directory', () => {
		expect(unresolvedImportsOf(bytesOf('import{tokenKey}from"./tokenKey.js";export const a=1;'))).toEqual([
			'./tokenKey.js',
		]);
	});

	it('names a specifier only a DYNAMIC import carries, which is the one that survives to the first fold', () => {
		expect(unresolvedImportsOf(bytesOf('export const load=async()=>await import("viem");'))).toEqual(['viem']);
	});

	it('reports each unresolved specifier ONCE, in the order the bundle carries them', () => {
		expect(unresolvedImportsOf(bytesOf('import"viem";import{a}from"abitype";import{b}from"viem";'))).toEqual([
			'viem',
			'abitype',
		]);
	});

	it('admits a node builtin, prefixed or bare, because a `data:` URL resolves one', () => {
		expect(unresolvedImportsOf(bytesOf('import{createHash}from"node:crypto";export const a=1;'))).toEqual([]);
		expect(unresolvedImportsOf(bytesOf('import{createHash}from"crypto";export const a=1;'))).toEqual([]);
	});

	it('is not fooled by an export clause, a default export or `import.meta`', () => {
		expect(unresolvedImportsOf(bytesOf('var o={a:1},p=o;export{p as default,o as processor};'))).toEqual([]);
		expect(unresolvedImportsOf(bytesOf('export default"viem";'))).toEqual([]);
		expect(unresolvedImportsOf(bytesOf('export const where=import.meta.url;'))).toEqual([]);
	});

	it('is not fooled by a bundle that merely MENTIONS a package name', () => {
		expect(unresolvedImportsOf(bytesOf('export const docs="viem";export const also=["abitype"];'))).toEqual([]);
	});

	it('is not fooled by an import STATEMENT quoted inside a string, which is not at a statement position', () => {
		expect(unresolvedImportsOf(bytesOf('export const help=\'run import{x}from"viem" to see\';'))).toEqual([]);
	});

	it('finds a statement wherever a bundler can put one: first byte, after a `;`, after a `}`, after a newline', () => {
		expect(unresolvedImportsOf(bytesOf('import"a/one";import"a/two";'))).toEqual(['a/one', 'a/two']);
		expect(unresolvedImportsOf(bytesOf('function f(){}export*from"a/three";'))).toEqual(['a/three']);
		expect(unresolvedImportsOf(bytesOf('const a = 1;\nimport {b} from "a/four";\n'))).toEqual(['a/four']);
	});
});

// ---------------------------------------------------------------------------------------------------
// loadProcessorArtifact -- a bundle becomes a running processor
// ---------------------------------------------------------------------------------------------------

describe('loadProcessorArtifact', () => {
	it('instantiates the committed bundle and hands back the processor it was built from', async () => {
		const bundle = theCommittedBundle();
		const outcome = await loadProcessorArtifact<Abi, unknown, FixtureProcessor>(bundle);
		if (outcome.status !== 'instantiated') {
			throw new Error(`expected the committed bundle to instantiate, got ${outcome.reason}: ${outcome.why}`);
		}
		expect(outcome.identity).toBe(processorArtifactIdentity(bundle));
		// The DECLARATIONS survived the bundler, which is what a store reads.
		expect(outcome.processor.entities).toEqual(createProcessorFromSource().entities);
		// And the FOLD does what the source's does, which is the round trip: the
		// handler runs, through the sibling module the bundler inlined (the id is
		// `tokenKey(42n)`), and writes the same mutation.
		expect(foldATransfer(outcome.processor)).toEqual(foldATransfer(createProcessorFromSource()));
		expect(foldATransfer(outcome.processor)).toEqual([
			{entity: 'nft', id: '42'.padStart(78, '0'), values: {owner: '0xf00'}},
		]);
	});

	it('instantiates bytes that were never on a filesystem, and needs no temporary file to do it', async () => {
		// The whole point of the arrival: the artifact exists only in memory here,
		// there is no path to import and nothing is written anywhere. It is what
		// makes a pushed artifact and a retained one possible later.
		const outcome = await loadProcessorArtifact<Abi, unknown, {fold: (n: number) => number}>(
			bytesOf('const bump=n=>n+1;export const createProcessor=()=>({fold:bump});'),
		);
		if (outcome.status !== 'instantiated') {
			throw new Error(`expected in-memory bytes to instantiate, got ${outcome.reason}`);
		}
		expect(outcome.processor.fold(1)).toBe(2);
	});

	it('hands back the MODULE too, because contract data rides on it and is not the processor', async () => {
		const outcome = await loadProcessorArtifact<Abi, unknown, unknown>(
			bytesOf('export const createProcessor=()=>({});export const contractsData=[{address:"0xabc"}];'),
		);
		if (outcome.status !== 'instantiated') throw new Error(`expected instantiation, got ${outcome.reason}`);
		expect(outcome.processorModule.contractsData).toEqual([{address: '0xabc'}]);
	});

	it('REFUSES a bundle that is not self-contained, naming the unresolved specifier', async () => {
		const outcome = await loadProcessorArtifact(
			bytesOf('import{createPublicClient}from"viem";export const createProcessor=()=>({});'),
		);
		if (outcome.status !== 'refused' || outcome.reason !== 'not-self-contained') {
			throw new Error(`expected a not-self-contained refusal, got ${JSON.stringify(outcome)}`);
		}
		expect(outcome.unresolvedImports).toEqual(['viem']);
		expect(outcome.why).toContain('viem');
	});

	it('refuses as DATA and never as a throw, so a caller can branch on the reason', async () => {
		// The seed-install path's contract, and the reason this returns an outcome
		// rather than raising: every refusal here is an ordinary condition about a
		// foreign artifact, which a host renders.
		await expect(
			loadProcessorArtifact(bytesOf('import"viem";export const createProcessor=()=>({});')),
		).resolves.toMatchObject({status: 'refused'});
	});

	it('carries the artifact IDENTITY on a refusal, because bytes have a name whether or not they load', async () => {
		const bundle = bytesOf('import"viem";export const createProcessor=()=>({});');
		const outcome = await loadProcessorArtifact(bundle);
		expect(outcome.identity).toBe(processorArtifactIdentity(bundle));
	});

	it('refuses the artifact BEFORE evaluating it, so its top-level code never runs', async () => {
		// The ordering the seed install makes structural: everything checkable
		// happens before the irreversible act. Evaluation is irreversible here --
		// the module joins the process registry for the life of the process and its
		// top-level code RUNS -- so a bundle that is not self-contained must not
		// reach it. The marker is what proves the check was STATIC: this bundle's
		// unresolved import is DYNAMIC, so Node would happily evaluate it and the
		// side effect would land.
		const marker = `__artifactEvaluated${Date.now()}`;
		const outcome = await loadProcessorArtifact(
			bytesOf(`globalThis.${marker}=true;export const createProcessor=()=>({load:()=>import("viem")});`),
		);
		expect(outcome.status).toBe('refused');
		expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
	});

	it('refuses bytes that are not a module at all', async () => {
		const outcome = await loadProcessorArtifact(bytesOf('export const = ;'));
		if (outcome.status !== 'refused') throw new Error('expected a refusal');
		expect(outcome.reason).toBe('unreadable-module');
	});

	it('refuses a module whose top-level code threw, rather than leaving the throw to the caller', async () => {
		const outcome = await loadProcessorArtifact(bytesOf('throw new Error("boom");'));
		if (outcome.status !== 'refused') throw new Error('expected a refusal');
		expect(outcome.reason).toBe('unreadable-module');
		expect(outcome.why).toContain('boom');
	});

	it('refuses a module that evaluated but carries no processor', async () => {
		const outcome = await loadProcessorArtifact(bytesOf('export const somethingElse=1;'));
		if (outcome.status !== 'refused') throw new Error('expected a refusal');
		expect(outcome.reason).toBe('not-a-processor');
	});

	it('refuses a module still returning the retired kind tag, by the one rule that already owns it', async () => {
		// ADR-0037's refusal lives in `instantiateProcessor` and is reused rather
		// than restated, so there is one module-shape rule and not two.
		const outcome = await loadProcessorArtifact(
			bytesOf('export const createProcessor=()=>({kind:"entities",processor:{}});'),
		);
		if (outcome.status !== 'refused') throw new Error('expected a refusal');
		expect(outcome.reason).toBe('not-a-processor');
		expect(outcome.why).toContain('kind');
	});

	it('hands the factory the config a caller supplied, and calls it with no arguments otherwise', async () => {
		const bundle = bytesOf('export const createProcessor=(config)=>({saw:config===undefined?"nothing":config});');
		const withConfig = await loadProcessorArtifact<Abi, unknown, {saw: unknown}>(bundle, {
			processorConfig: {folder: './data'},
		});
		if (withConfig.status !== 'instantiated') throw new Error('expected instantiation');
		expect(withConfig.processor.saw).toEqual({folder: './data'});

		const without = await loadProcessorArtifact<Abi, unknown, {saw: unknown}>(bundle);
		if (without.status !== 'instantiated') throw new Error('expected instantiation');
		expect(without.processor.saw).toBe('nothing');
	});
});
