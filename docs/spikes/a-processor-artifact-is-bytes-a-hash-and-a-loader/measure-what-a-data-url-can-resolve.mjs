/**
 * WHAT A `data:` URL MODULE CAN RESOLVE, measured against Node itself.
 *
 * `unresolvedImportsOf` (`@etherfold/utils`, `src/processorArtifact.ts`) refuses
 * an artifact that still imports something, and the one interesting question is
 * WHICH specifiers are genuinely unresolvable, because a check that refuses an
 * artifact which actually runs is worse than no check: it is a refusal the
 * author cannot act on.
 *
 * The answer is not obvious from the documentation. A `data:` URL has no base to
 * resolve against, so bare and relative specifiers are both dead -- but BUILTINS
 * resolve, prefixed AND unprefixed, and that is what decides the one exception
 * the check makes.
 *
 * It also records how each failure ARRIVES, which is what the loader's refusal
 * reasons are shaped around: an unresolvable import fails at LINK time (a
 * `TypeError`, before any code runs), a syntax error at parse time, and a
 * throwing module body at evaluation time.
 *
 *   node docs/spikes/a-processor-artifact-is-bytes-a-hash-and-a-loader/measure-what-a-data-url-can-resolve.mjs
 *
 * No dependencies: it is Node measuring itself. See README.md beside it for the
 * output on the day it was run.
 */

/** One artifact, as bytes, imported the way the loader imports one. */
async function attempt(label, source) {
	const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
	try {
		const module = await import(url);
		return {label, outcome: 'imported', exports: Object.keys(module)};
	} catch (error) {
		return {
			label,
			outcome: 'refused',
			error: error.constructor.name,
			code: error.code,
			message: String(error.message).split('\n')[0].slice(0, 160),
		};
	}
}

const cases = [
	['no imports at all', 'export const a = 1;'],
	['a prefixed builtin', 'import {randomUUID} from "node:crypto"; export const a = randomUUID();'],
	['an unprefixed builtin', 'import crypto from "crypto"; export const a = typeof crypto;'],
	['a bare package specifier', 'import {x} from "viem"; export const a = 1;'],
	['a relative specifier', 'import {x} from "./sibling.js"; export const a = 1;'],
	['a dynamic bare specifier, never called', 'export const load = async () => await import("viem");'],
	['a syntax error', 'export const = ;'],
	['a module body that throws', 'throw new Error("boom");'],
];

const results = [];
for (const [label, source] of cases) {
	results.push(await attempt(label, source));
}

console.log(`node ${process.version} on ${process.platform}`);
for (const result of results) {
	console.log(JSON.stringify(result));
}
