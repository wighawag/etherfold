import {describe, expect, it} from 'vitest';
import {hook} from 'named-logs';

/**
 * THE DEVELOPER'S COPY OF THE DEMOTION, and why it is asserted in a file of its
 * own.
 *
 * `syncing.demotion` is what an APP renders; this is what a developer finds when
 * they wonder why the numbers stopped moving, and without it a tab that quietly
 * stopped indexing for ever is exactly as silent as the corruption the writer
 * guard replaced. So it is a claim worth holding rather than a courtesy.
 *
 * `named-logs` resolves its factory when a module builds its logger, and a module
 * that built one before a factory was hooked holds the no-op for good. Every
 * other test in this package imports the hook (and therefore `demotion.ts`) at
 * the top of the file, so the hook has to be installed HERE, before the first
 * import of the module under test -- which is why this is one file with a
 * DYNAMIC import rather than a case beside the others.
 */

const warnings: string[] = [];

const noop = () => {};
hook(
	() =>
		({
			assert: noop,
			error: noop,
			warn: (...data: unknown[]) => warnings.push(data.map(String).join(' ')),
			info: noop,
			log: noop,
			debug: noop,
			dir: noop,
			table: noop,
			trace: noop,
			write: noop,
			time: noop,
			timeEnd: noop,
			timeLog: noop,
		}) as never,
);

describe('a demotion is audible', () => {
	it('warns through named-logs, naming the reason and what to do about it', async () => {
		const {demoteToReader} = await import('../src/demotion.js');

		demoteToReader({stopFolding: noop, forgetCursor: noop, stores: () => []}, 'write-refused');

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('DEMOTED');
		expect(warnings[0]).toContain('write-refused');
		// the two things a developer reading it has to learn: reads still work, and
		// there is nothing to retry.
		expect(warnings[0]).toContain('ANSWERING READS');
		expect(warnings[0]).toContain('nothing to retry');
	});
});
