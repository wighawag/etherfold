import {createHash} from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import {afterAll, describe, expect, it} from 'vitest';

// ---------------------------------------------------------------------------------------------------
// AN ETHERFOLD UPGRADE DOES NOT MOVE THE IDENTITY OF A BUNDLE WHOSE CODE DID NOT CHANGE
// ---------------------------------------------------------------------------------------------------
// A processor's identity is the SHA-256 of its bundle's bytes (ADR-0086), and a
// published snapshot is found by it (ADR-0095). So whatever etherfold puts into an
// app's bundle that the processor never runs still moves the identity when it
// changes, and every existing publication stops being found.
//
// What used to be put there is the module-level `const logger = logs('...')` of
// every module the package barrel reaches: without `"sideEffects": false` a
// bundler must keep that call, even when the app imports one pure function. So
// adding one logger to an etherfold module an app never calls (0.4.0's
// `stateFactories.ts`) moved the stratagems bundle's identity.
//
// The check runs on the packages AS THEY ARE PUBLISHED: each one's `package.json`
// and built `dist/` (what the tarball carries; there is no `files` field, but the
// sources and tests beside them are never what a bundler resolves) laid out in a
// fresh `node_modules`, walked from this package's runtime `dependencies`. A new
// etherfold runtime dependency is therefore covered the day it is added.
// What it does NOT cover: `@etherfold/utils` (Node-side glue a processor bundle
// does not reach from here, though it declares the field too), and a third-party
// package two etherfold packages depend on at different versions (the first copy
// placed wins). It needs
// `pnpm build` first, like every test that imports a sibling package.
//
// The bundling is the documented command (`esbuild --bundle --format=esm --minify`).
// ---------------------------------------------------------------------------------------------------

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const workspaces: string[] = [];
afterAll(() => {
	for (const dir of workspaces) rmSync(dir, {recursive: true, force: true});
});

type Layout = {
	/** Strip `sideEffects` from every installed etherfold package: the fix, removed. */
	readonly withoutSideEffects?: boolean;
	/** Add a logger-carrying module to an etherfold package, reached from its barrel, that no processor calls. */
	readonly anUnrelatedModuleGainsALogger?: boolean;
};

/** The logger name the fixture module creates, so a bundle that kept it says so by name. */
const GAINED_LOGGER = '@etherfold/processor-entities:an-unrelated-module-gained-a-logger';

/**
 * INSTALL `@etherfold/processor-entities` as an app would get it: every etherfold
 * package it reaches copied as published (`package.json` + `dist/`), every other
 * package linked to the one this workspace resolved.
 */
function install(layout: Layout = {}): string {
	const root = mkdtempSync(join(tmpdir(), 'etherfold-bundle-identity-'));
	workspaces.push(root);
	const modules = join(root, 'node_modules');
	const installed = new Set<string>();

	function place(name: string, from: string): void {
		if (installed.has(name)) return;
		installed.add(name);
		const to = join(modules, name);
		mkdirSync(dirname(to), {recursive: true});
		const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf-8')) as {
			name: string;
			sideEffects?: unknown;
			dependencies?: Record<string, string>;
		};
		if (!name.startsWith('@etherfold/')) {
			symlinkSync(from, to, 'dir');
			return;
		}
		if (!existsSync(join(from, 'dist'))) {
			throw new Error(`${name} has no dist/ at ${from}: run \`pnpm build\` first`);
		}
		mkdirSync(to, {recursive: true});
		cpSync(join(from, 'dist'), join(to, 'dist'), {recursive: true});
		if (layout.withoutSideEffects) delete manifest.sideEffects;
		writeFileSync(join(to, 'package.json'), JSON.stringify(manifest, null, '\t'));
		for (const dependency of Object.keys(manifest.dependencies ?? {})) {
			place(dependency, realpathSync(join(from, 'node_modules', dependency)));
		}
	}
	place('@etherfold/processor-entities', PACKAGE_DIR);

	if (layout.anUnrelatedModuleGainsALogger) {
		const dist = join(modules, '@etherfold/processor-entities/dist');
		writeFileSync(
			join(dist, 'anUnrelatedModule.js'),
			[
				`import {logs} from 'named-logs';`,
				`const logger = logs(${JSON.stringify(GAINED_LOGGER)});`,
				`export function somethingNoProcessorCalls() { logger.info('called'); }`,
				'',
			].join('\n'),
		);
		writeFileSync(
			join(dist, 'index.js'),
			`${readFileSync(join(dist, 'index.js'), 'utf-8')}\nexport * from './anUnrelatedModule.js';\n`,
		);
	}
	return root;
}

/** A minimal processor entry: `declareEntities` and nothing else. */
const MINIMAL_ENTRY = `import {declareEntities} from '@etherfold/processor-entities';
export const e = declareEntities([{name: 'a', id: 'id', fields: {n: 'integer'}}]);
`;

/**
 * The shape of the stratagems processor: `declareEntities`, the `MutationContext`
 * type its handlers write through, and a module-level constant.
 */
const STRATAGEMS_LIKE_ENTRY = `import {declareEntities, type MutationContext} from '@etherfold/processor-entities';
const WINDOW = 7;
const entities = declareEntities([
	{name: 'placement', id: 'id', fields: {window: 'integer', player: 'text'}},
]);
export default {
	entities,
	onCommitmentRevealed(state: MutationContext, event: {args: {player: string}}) {
		state.set('placement', String(WINDOW), {window: WINDOW, player: event.args.player});
	},
};
`;

type Bundle = {readonly text: string; readonly identity: string; readonly loggers: string[]};

function bundle(root: string, name: string, source: string): Bundle {
	const entry = join(root, name);
	writeFileSync(entry, source);
	const result = buildSync({
		entryPoints: [entry],
		absWorkingDir: root,
		bundle: true,
		format: 'esm',
		minify: true,
		write: false,
		logLevel: 'silent',
	});
	const bytes = result.outputFiles[0].contents;
	const text = new TextDecoder().decode(bytes);
	return {
		text,
		identity: createHash('sha256').update(bytes).digest('hex'),
		// every etherfold logger name is a string literal `@etherfold/...`, so each one
		// the bundle kept is named here, and a failure says which module to look at
		loggers: [...text.matchAll(/["'`](@etherfold\/[^"'`]*)["'`]/g)].map((match) => match[1]),
	};
}

describe('a processor bundle carries no etherfold logger it never runs', () => {
	it('the minimal entry (declareEntities, nothing else) bundles to no etherfold logger', () => {
		const {loggers} = bundle(install(), 'entry.js', MINIMAL_ENTRY);
		expect(loggers, 'etherfold loggers the bundle kept: a module-level side effect reached the processor').toEqual([]);
	});

	it('the stratagems-like entry bundles to no etherfold logger', () => {
		const {loggers} = bundle(install(), 'entry.ts', STRATAGEMS_LIKE_ENTRY);
		expect(loggers, 'etherfold loggers the bundle kept: a module-level side effect reached the processor').toEqual([]);
	});

	it('the stratagems-like bundle keeps its bytes when an unrelated etherfold module gains a logger', () => {
		const before = bundle(install(), 'entry.ts', STRATAGEMS_LIKE_ENTRY);
		const after = bundle(install({anUnrelatedModuleGainsALogger: true}), 'entry.ts', STRATAGEMS_LIKE_ENTRY);
		expect(after.loggers).toEqual([]);
		expect(after.text).toBe(before.text);
		expect(after.identity).toBe(before.identity);
	});

	// THE FIX, REMOVED, in the test itself: without `"sideEffects": false` the same
	// fixture DOES move the identity and the bundle carries the loggers. This is what
	// makes the two checks above mean something: the perturbation is real, and the
	// field is what absorbs it. (If loggers are ever made lazy instead, this control is
	// what changes, not the checks above.)
	it('control: without "sideEffects": false, the same logger moves the identity', () => {
		const before = bundle(install({withoutSideEffects: true}), 'entry.ts', STRATAGEMS_LIKE_ENTRY);
		const after = bundle(
			install({withoutSideEffects: true, anUnrelatedModuleGainsALogger: true}),
			'entry.ts',
			STRATAGEMS_LIKE_ENTRY,
		);
		expect(before.loggers.length).toBeGreaterThan(0);
		expect(after.loggers).toContain(GAINED_LOGGER);
		expect(after.identity).not.toBe(before.identity);
	});
});
