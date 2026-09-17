/**
 * Renders the raw results/ rows as the matrices the finding quotes, so that the tables in
 * `work/notes/findings/` are DERIVED from the measurement rather than transcribed by hand.
 *
 *   node summarise.mjs            # every engine that was measured
 *   node summarise.mjs chromium   # one
 */
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wanted = process.argv.slice(2);

const files = readdirSync(join(here, 'results'))
	.filter((name) => name.startsWith('csp-') && name.endsWith('.json'))
	.filter((name) => wanted.length === 0 || wanted.some((engine) => name === `csp-${engine}.json`));

/** `ran` is the only success: instantiation is proved by FOLDING, not by a missing error. */
function cell(row) {
	if (!row) return '--';
	if (row.ok && row.proof && row.proof.ran) return 'ran';
	if (row.ok && row.inside) return 'see worker rows';
	return 'no';
}

function documentRow(run, mechanism) {
	return cell((run.results.document ?? []).find((entry) => entry.mechanism === mechanism));
}

function workerRow(run, workerMechanism, mechanism) {
	const worker = (run.results.workers ?? []).find((entry) => entry.mechanism === workerMechanism);
	if (!worker || !worker.ok || !worker.inside || !worker.inside.results) return 'no';
	return cell(worker.inside.results.find((entry) => entry.mechanism === mechanism));
}

const MECHANISMS = ['blob-import', 'data-import', 'new-function', 'blob-worker', 'blob-import-corrupt-bytes'];

for (const file of files) {
	const report = JSON.parse(readFileSync(join(here, 'results', file), 'utf8'));
	console.log(`\n## ${report.engine} ${report.version ?? ''} (${report.measuredAt})`);
	if (!report.launched) {
		console.log(`not measured here: ${report.why}`);
		continue;
	}

	for (const delivery of ['header', 'meta']) {
		console.log(`\n### policy delivered as a ${delivery}\n`);
		console.log(`| policy | ${MECHANISMS.join(' | ')} | service-worker URL | in a worker with no CSP of its own |`);
		console.log(`| --- | ${MECHANISMS.map(() => '---').join(' | ')} | --- | --- |`);
		for (const run of report.runs.filter((entry) => entry.delivery === delivery)) {
			const cells = MECHANISMS.map((mechanism) => documentRow(run, mechanism));
			const sw = cell(run.results.serviceWorker);
			const inWorker = workerRow(run, 'same-origin-worker[csp=none]', 'blob-import');
			console.log(`| \`${run.csp ?? '(none)'}\` | ${cells.join(' | ')} | ${sw} | ${inWorker} |`);
		}
	}

	console.log('\n### what a refusal REPORTS (header delivery)\n');
	for (const run of report.runs.filter((entry) => entry.delivery === 'header')) {
		for (const row of run.results.document ?? []) {
			if (row.ok) continue;
			const error = row.error ?? {};
			const violation = row.violations && row.violations[0];
			console.log(
				`- \`${run.policy}\` / ${row.mechanism}: ${error.name ?? error.arrival ?? '?'}: ${JSON.stringify(error.message ?? '')}` +
					(violation ? ` [violation ${violation.effectiveDirective} ${violation.blockedURI}]` : ' [no violation event]'),
			);
		}
	}
}
