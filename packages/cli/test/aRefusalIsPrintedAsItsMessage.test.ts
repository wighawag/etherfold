import {afterEach, describe, expect, it, vi} from 'vitest';
import {nodeMain, runMain} from '../src/run.js';

// A CONFIGURATION REFUSAL IS WRITTEN TO BE READ: it names the flag, the variable and
// the command that owns the input. On the terminal it is printed as that message, and
// not as an `Error` whose stack through the resolver buries it (found by a hand smoke
// test on 2026-09-26: `run`, `node`, `build` and `index` printed the stack; `fetch`
// and `upload` did not).

afterEach(() => {
	vi.restoreAllMocks();
});

async function printedBy(main: typeof runMain, options: Parameters<typeof runMain>[0]): Promise<unknown[][]> {
	const printed: unknown[][] = [];
	vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		printed.push(args);
	});
	const exits: number[] = [];
	await main(options, {exit: (code) => exits.push(code), log: () => {}, handleSignals: false});
	expect(exits).toEqual([1]);
	return printed;
}

describe('a command that stops on a refusal prints the MESSAGE, with no stack', () => {
	it('`run` with no processor', async () => {
		const printed = await printedBy(runMain, {store: 'sqlite', db: ':memory:', nodeUrl: 'http://localhost:0'});
		expect(printed[0]).toHaveLength(1);
		expect(typeof printed[0]![0]).toBe('string');
		expect(printed[0]![0]).toMatch(/--processor is required by `etherfold run`/);
		expect(String(printed[0]![0])).not.toMatch(/\n\s+at /);
	});

	it('`node` given a processor', async () => {
		const printed = await printedBy(nodeMain, {
			processor: './dist/processor.js',
			store: 'sqlite',
			db: ':memory:',
			nodeUrl: 'http://localhost:0',
		});
		expect(typeof printed[0]![0]).toBe('string');
		expect(printed[0]![0]).toMatch(/is not accepted by `etherfold node`/);
	});
});
