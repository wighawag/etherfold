import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {refuseUnbundledProcessor} from '../src/config.js';

// ---------------------------------------------------------------------------------------------------
// THE REFUSAL AND THE DOCUMENTATION NAME ONE COMMAND, DOWN TO THE FLAGS
// ---------------------------------------------------------------------------------------------------
// An author meets the REFUSAL first and the documentation second. Two spellings
// of the build command is worse than either alone: the one that is stuck reads
// both, cannot tell which is current, and the difference they are most likely to
// resolve by taste is the one that is not a matter of taste at all.
//
// `--minify` is a CORRECTNESS rule for IDENTITY and not a size preference.
// Un-minified esbuild output carries a `// <path>` banner per module, so the
// BUILDING MACHINE'S DIRECTORY LAYOUT ends up in the bytes: the same source built
// from two directories hashed DIFFERENTLY un-minified and IDENTICALLY minified
// (measured at launch, `work/specs/tasked/a-processor-is-a-bundle-and-its-hash-is-its-identity.md`).
// A generation is named by the sha256 of those bytes (ADR-0086), so a developer
// and CI dropping the flag do not produce a bigger bundle, they disagree about
// which generation they are.
//
// So the flag set is pinned in THREE places at once, against the one emitter:
//
//   1. `packages/cli/README.md` -- the canonical documented command, which is
//      what an author starting out reads.
//   2. `examples/event-processor-nfts/README.md` -- the worked instance of it.
//   3. that example's `build:bundle` script -- the copy that RUNS, and which the
//      acceptance gate then proves produces something the loader accepts.
//
// The emitter is `refuseUnbundledProcessor` itself rather than a constant this
// file keeps its own copy of: a test carrying its own spelling is a fourth source
// of truth, and it would agree with nobody the day the message changes.
//
// What is compared is the command's SHAPE: the tool, the flags and their ORDER,
// with the entry path and the `--outfile=` target (which legitimately differ per
// caller) replaced by placeholders. Everything else is byte equality, so a
// dropped `--minify`, a reordered flag or a switch of bundler fails here.
// ---------------------------------------------------------------------------------------------------

const REPO_ROOT = new URL('../../../', import.meta.url);

/** The scratch directories these cases write an entry point into, outside the repository. */
const scratch: string[] = [];

afterEach(async () => {
	for (const dir of scratch.splice(0)) {
		await rm(dir, {recursive: true, force: true}).catch(() => undefined);
	}
});

/**
 * The command the REFUSAL hands an author, read out of the message it really emits.
 *
 * The entry-point branch is used deliberately: it substitutes a real path for the
 * entry, so the whole line is one token per argument and the shape below can be
 * taken from it without parsing prose.
 */
async function theCommandTheRefusalGives(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-docs-'));
	scratch.push(dir);
	const entry = join(dir, 'processor.mjs');
	await writeFile(entry, `import './abi.js';\nexport const createProcessor = () => ({});\n`, 'utf-8');

	try {
		await refuseUnbundledProcessor('build', entry);
	} catch (err) {
		const lines = (err as Error).message.split('\n').filter((line) => line.trim().length > 0);
		return lines[lines.length - 1].trim();
	}
	throw new Error('an entry point that still imports was not refused, so there is no command to compare');
}

/**
 * ONE command reduced to what must be identical everywhere: the tool, the flags,
 * and the order they are written in.
 *
 * The two things that legitimately differ are replaced rather than dropped, so a
 * copy that forgot `--outfile` altogether still fails: the ENTRY (each caller
 * bundles its own) and the OUTFILE target (each caller writes its own). The tool
 * is taken by basename, because the example runs the workspace's own binary by
 * path rather than off the PATH.
 */
function shapeOf(command: string): string {
	const [binary, entry, ...flags] = command.trim().split(/\s+/);
	if (binary === undefined || entry === undefined) {
		throw new Error(`not a build command: ${JSON.stringify(command)}`);
	}
	const tool = binary.split('/').pop();
	return [tool, '<ENTRY>', ...flags.map((flag) => (flag.startsWith('--outfile=') ? '--outfile=<OUT>' : flag))].join(
		' ',
	);
}

/**
 * The command a document states, taken from the fenced block under its anchor.
 *
 * Anchored by an HTML comment rather than found by searching for `esbuild`, on
 * the precedent of the provider-surface claim in `@etherfold/core`: the check is
 * against the line somebody wrote ON PURPOSE as the documented command, prose
 * elsewhere in the file is free, and the anchor tells the next editor that this
 * block is held to the code.
 */
function theCommandDocumentedIn(text: string, where: string): string {
	const anchor = text.indexOf('<!-- bundle-command:');
	if (anchor === -1) {
		throw new Error(
			`${where} carries no bundle-command anchor: the command an author copies is no longer held to the ` +
				`refusal they meet first`,
		);
	}
	const afterAnchor = text.slice(text.indexOf('-->', anchor) + 3);
	const fence = afterAnchor.match(/```[a-z]*\n([\s\S]*?)```/);
	if (!fence) {
		throw new Error(`${where} has a bundle-command anchor with no fenced command under it`);
	}
	const command = fence[1]
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!command) {
		throw new Error(`${where} has a bundle-command anchor with an empty block under it`);
	}
	return command;
}

async function textOf(relative: string): Promise<string> {
	return readFile(fileURLToPath(new URL(relative, REPO_ROOT)), 'utf-8');
}

describe('the documentation states the command the refusal gives', () => {
	/** Every place the command is WRITTEN OUT for a reader, canonical statement first. */
	const DOCUMENTS = ['packages/cli/README.md', 'examples/event-processor-nfts/README.md'];

	for (const document of DOCUMENTS) {
		it(`agrees with it flag for flag, in ${document}`, async () => {
			const documented = theCommandDocumentedIn(await textOf(document), document);
			expect(shapeOf(documented)).toEqual(shapeOf(await theCommandTheRefusalGives()));
		});
	}

	it('agrees with the example script that RUNS it, so the documented command is an executed one', async () => {
		// The example bundles through the workspace's own esbuild binary and is what
		// `pnpm test` then folds under the CLI, so this is the copy with evidence
		// behind it. A documented command nothing runs is a claim.
		const manifest = JSON.parse(await textOf('examples/event-processor-nfts/package.json')) as {
			scripts: Record<string, string>;
		};
		expect(shapeOf(manifest.scripts['build:bundle'])).toEqual(shapeOf(await theCommandTheRefusalGives()));
	});

	it('is a MINIFIED ESM bundle, which is the identity rule rather than a preference', async () => {
		// Pinned on its own, because the three copies above could agree with each
		// other and be wrong together. Dropping `--minify` puts the building
		// machine's directory layout in the bytes, and two machines building one
		// source then disagree about which generation they are.
		const shape = shapeOf(await theCommandTheRefusalGives());
		expect(shape).toContain('--bundle');
		expect(shape).toContain('--format=esm');
		expect(shape).toContain('--minify');
		// and the output is ONE file, named by the caller
		expect(shape).toContain('--outfile=<OUT>');
	});
});
