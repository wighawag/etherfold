import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// ---------------------------------------------------------------------------------------------------
// THERE IS ONE SERVER-SIDE FOLDING ENGINE, AND IT IS NOT `IndexerGeneration`
// ---------------------------------------------------------------------------------------------------
// `work/specs/tasked/one-command-runs-the-whole-pipeline.md` builds `run` and
// `index` on the same `StreamBuilder` and asserts they produce identical state
// from the same input. That assertion is worth making only if the transport is
// the only difference between them: if this command folded through
// `IndexerGeneration` instead, the equivalence would be between two
// IMPLEMENTATIONS that happen to agree today, and every later divergence would
// surface as a mysteriously failing equivalence test rather than as a bug in one
// place.
//
// So it is asserted rather than claimed, by reading this package's own sources.
// A grep is crude and it is the right shape here: what must not exist is a
// construction, and the file that would introduce one is the file this reads.
// That engine stays the browser's.
//
// IT HAS ONE NAME AGAIN, AND THE GUARD MATCHES THAT ONE. The class is
// `IndexerGeneration` -- one stream, one processor, one state IS a GENERATION --
// and the second spelling it carried through the rename was deleted with the old
// shape (`the-old-indexer-shape-is-deleted`), so that spelling came out of the
// patterns below with it. A guard left on an identifier nothing can resolve any
// more would stay GREEN and enforce nothing, which is worse than no guard.
// Deliberately NOT extended to `Indexer`, the generation CONTAINER, and that is
// now a POSITIVE statement rather than a deferral: the CLI holds generations
// through `ReceivingIndexer` (`openReceivingIndexer`), the CHAIN-FREE container
// over the same `StreamBuilder` -- which is exactly why it can, since
// `IndexerGeneration` opens `load()` with `eth_chainId` and could never be split
// into the two halves a receiver is one of. Holding generations and constructing
// the browser's engine are two different questions, and only the second is
// refused here.
//
// A SOURCE-TEXT GUARD IS ONLY WORTH ITS LINES IF IT STILL BITES, so the patterns
// are named here and asserted against deliberate violations below. A rename that
// left them on an identifier nothing uses any more would keep them green and
// VACUOUS -- passing forever, enforcing nothing, with nothing going red to say
// so. That is the one failure mode this file cannot detect by reading `src/`,
// because `src/` is clean either way.
// ---------------------------------------------------------------------------------------------------

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Does this source text CONSTRUCT the browser engine? */
function constructsEngine(text: string): boolean {
	return /new\s+IndexerGeneration\b|\bIndexerGeneration\s*[<(]/.test(text);
}

/**
 * Does it IMPORT the identifier?
 *
 * Separate from the construction check because the words appear in PROSE in this
 * package (it explains why it does not use that class), so the reachable-symbol
 * question is asked about an import rather than about a mention.
 */
function importsEngine(text: string): boolean {
	return /import\s*\{[^}]*\bIndexerGeneration\b[^}]*\}/.test(text);
}

function sources(): {file: string; text: string}[] {
	return fs
		.readdirSync(src)
		.filter((name) => name.endsWith('.ts'))
		.map((file) => ({file, text: fs.readFileSync(path.join(src, file), 'utf-8')}));
}

describe("the CLI's indexing path", () => {
	it('constructs no IndexerGeneration', () => {
		const offenders = sources().filter(({text}) => constructsEngine(text));
		expect(offenders.map(({file}) => file)).toEqual([]);
	});

	it('does not import it either, so nothing can quietly start using one', () => {
		const offenders = sources().filter(({text}) => importsEngine(text));
		expect(offenders.map(({file}) => file)).toEqual([]);
	});

	it('assembles the two ADR-0003 halves instead', () => {
		const index = fs.readFileSync(path.join(src, 'index.ts'), 'utf-8');
		const folding = fs.readFileSync(path.join(src, 'folding.ts'), 'utf-8');
		// the RECEIVING half, built by the generation container so that a changed
		// context creates a successor instead of reaching `processor.clear()`: it is a
		// `StreamBuilder` either way, and the container is what holds several of them
		expect(folding).toMatch(/openReceivingIndexer/);
		expect(index).toMatch(/createDirectIngestion/);
		// the LogFetcher is built by the fetcher host, which also owns the cycle
		// classification and the backoff this command's one-shot rides on
		expect(index).toMatch(/createFetcherHost/);
		expect(index).toMatch(/runFetcherLoop/);
	});
});

/**
 * THE GUARD BITES: the same patterns, put in front of deliberate violations.
 *
 * The two checks above pass because `src/` is clean. They would ALSO pass if the
 * patterns matched nothing at all, which is exactly what a rename does to a
 * source-text guard left on the old identifier. So the violations are written
 * out here and the patterns are asserted to catch each one.
 */
describe('the guard that says so still bites', () => {
	const constructions = [
		[
			"a construction under the class's own name",
			`const engine = new IndexerGeneration(provider, processor, source, config);`,
		],
		['a type argument, which needs no `new` at all', `let engine: IndexerGeneration<Abi, void> | undefined;`],
		['a call of it, however it got here', `const engine = IndexerGeneration(provider);`],
	] as const;

	for (const [what, violation] of constructions) {
		it(`refuses ${what}`, () => {
			expect(constructsEngine(violation)).toBe(true);
		});
	}

	const imports = [
		['a bare import of it', `import {IndexerGeneration} from '@etherfold/core';`],
		[
			'one buried in a longer import list',
			`import {LogFetcher, IndexerGeneration, StreamBuilder} from '@etherfold/core';`,
		],
	] as const;

	for (const [what, violation] of imports) {
		it(`refuses ${what}`, () => {
			expect(importsEngine(violation)).toBe(true);
		});
	}

	it('leaves the CLI\u2019s own prose alone, which is why the import check is separate', () => {
		// this package's `src/index.ts` explains at length why it does NOT use that
		// class; a guard that fired on the explanation would be deleted within a week
		const prose = ` * ## Why this and not \`IndexerGeneration\`\n * ...it opens \`load()\` with \`eth_chainId\`.`;
		expect(constructsEngine(prose)).toBe(false);
		expect(importsEngine(prose)).toBe(false);
	});

	it('does not fire on the generation CONTAINER, which is a different question', () => {
		// `Indexer` is the container. Whether a CLI holds generations is
		// `the-server-and-cli-hold-generations-too`'s to answer, not this grep's.
		const container = `import {openIndexer, type Indexer} from '@etherfold/core';\nconst indexer: Indexer<Abi, void> = await openIndexer({});`;
		expect(constructsEngine(container)).toBe(false);
		expect(importsEngine(container)).toBe(false);
	});
});
