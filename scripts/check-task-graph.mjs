#!/usr/bin/env node
/**
 * Refuse a `blockedBy` that the runner will read as something other than what is written.
 *
 * ## Why this exists
 *
 * On 2026-09-19, the closing documentation task of the ADR-0087 family was written with four
 * blockers, so that it could not be claimed until every piece of the family had landed. That fan-in
 * is the exact mechanism `work/protocol/ADR-FORMAT.md` prescribes for expiring an
 * `accepted, not yet implemented` status, and it argues for it at length: "every task in a chain can
 * see that it is not the last one while the actual last one has no way to know that it is".
 *
 * `dorfl status` reported that task as `deps: satisfied (none)` and listed it as claimable
 * immediately, before any of the work it documents existed.
 *
 * The cause is a collision between two tools this repo runs together, and it FAILS OPEN. dorfl's
 * frontmatter parser implements exactly two list shapes and says so in its own header: the inline
 * flow form `[a, b]` and the block form `- a`. It is deliberately not general YAML. Prettier
 * formats markdown frontmatter as YAML under `printWidth: 120`, so an inline list longer than that
 * is rewritten into a MULTI-LINE FLOW list:
 *
 *     blockedBy:
 *       [
 *         one-slug,
 *         another-slug,
 *       ]
 *
 * That is valid YAML, it is what `pnpm format` produces, and it is neither shape the parser reads.
 * The list silently becomes `[]`. Nothing warns, and the failure is in the dangerous direction: a
 * task becomes MORE claimable, never less.
 *
 * The trigger is LENGTH alone, so it fires precisely on the tasks that most need the ordering — a
 * fan-in with three or more of this repo's usual slugs runs past 120 characters. Fixing the two
 * affected files by hand does not stop the third one appearing the next time someone writes a
 * fan-in, which is what makes this worth a gate rather than a sweep. It is the same argument
 * `check-work-refs.mjs` makes for itself, one field along.
 *
 * ## What it checks
 *
 * For every work item under `work/{tasks,specs}/`, the dependency keys (`blockedBy`, `taskedAfter`)
 * are parsed the way the RUNNER parses them, and compared against every slug-shaped token actually
 * written in that key's region of the frontmatter. A token that is written but not parsed is a
 * silently-dropped dependency, and it is refused, naming the file and the tokens that went missing.
 *
 * It deliberately checks AGREEMENT rather than a specific bad shape: it therefore also catches
 * whatever the next formatter change produces, which a check keyed on `[\n` would not.
 *
 * ## What it deliberately does NOT check
 *
 * TERMINAL positions are exempt -- `tasks/done/`, `tasks/cancelled/`, `specs/dropped/` -- on
 * `check-work-refs.mjs`'s own argument for exempting them: they are frozen records of what was
 * asked, not live ordering. An item that can never be claimed cannot be claimed too early, which is
 * the entire hazard here. This is not hypothetical tidiness: when this check was first run it found
 * three ALREADY-DONE tasks carrying wrapped `blockedBy` lists, which is to say the trap had fired
 * repeatedly and silently before anyone noticed it, and each of those tasks was built with its
 * ordering constraints invisible to the runner. Rewriting those records now would falsify them.
 *
 * Whether a named blocker EXISTS, or whether the graph is acyclic. Those are real questions and
 * they are the runner's to answer against the whole board (a blocker legitimately lives in
 * `tasks/done/`, and a repo may cite a slug it has not written yet). This check has one job: what
 * is written and what is read are the same list.
 */

import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';

/** The keys whose value is a list of slugs the runner orders work by. */
const DEPENDENCY_KEYS = ['blockedBy', 'taskedAfter'];

/** A slug as this repo writes them: lowercase, digits, hyphens. */
const SLUG_TOKEN = /[a-z0-9]+(?:-[a-z0-9]+)*/g;

/** Frontmatter is the block between the leading `---` and the next one. */
function frontmatterOf(content) {
	const normalized = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
	if (!normalized.startsWith('---\n')) return undefined;
	const lines = normalized.split('\n');
	const closing = lines.indexOf('---', 1);
	return closing === -1 ? undefined : lines.slice(1, closing);
}

/**
 * The lines belonging to `key`: its own line plus every following INDENTED continuation line. That
 * is what makes the multi-line flow list visible at all -- its items live on lines the naive
 * "one key, one line" reading never looks at.
 */
function regionOf(lines, key) {
	const start = lines.findIndex((line) => line.startsWith(`${key}:`));
	if (start === -1) return undefined;
	const region = [lines[start]];
	for (let i = start + 1; i < lines.length; i++) {
		if (!/^\s/.test(lines[i]) || lines[i].trim() === '') break;
		region.push(lines[i]);
	}
	return region;
}

/**
 * Parse the two shapes the RUNNER supports, and ONLY those: inline flow on the key's own line, or
 * block `- item` continuation lines. Anything else yields what the runner yields, which is the
 * whole point of the comparison below.
 */
function parseAsRunnerDoes(region, key) {
	const withoutComments = region.map((line) => line.replace(/#.*$/, ''));
	const head = withoutComments[0].slice(`${key}:`.length).trim();
	if (head.startsWith('[')) {
		const close = head.indexOf(']');
		// An unterminated `[` on the key's own line is the multi-line flow shape: the runner reads
		// it as empty, so this reads it as empty too.
		if (close === -1) return [];
		return head
			.slice(1, close)
			.split(',')
			.map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
			.filter(Boolean);
	}
	if (head === '') {
		return withoutComments
			.slice(1)
			.filter((line) => line.trim().startsWith('- '))
			.map((line) =>
				line
					.trim()
					.slice(2)
					.trim()
					.replace(/^['"]|['"]$/g, ''),
			)
			.filter(Boolean);
	}
	return [head.replace(/^['"]|['"]$/g, '')].filter(Boolean);
}

/** Every slug-shaped token actually WRITTEN in the region, comments and the key itself removed. */
function tokensWritten(region, key) {
	const text = region
		.map((line) => line.replace(/#.*$/, ''))
		.join('\n')
		.replace(`${key}:`, '');
	return (text.match(SLUG_TOKEN) ?? []).filter((token) => token.includes('-'));
}

/**
 * The verdict half, pure over the frontmatter lines, so the interesting cases can be asserted
 * without building a repo that exhibits them.
 */
function classifyItem(file, lines) {
	const problems = [];
	for (const key of DEPENDENCY_KEYS) {
		const region = regionOf(lines, key);
		if (!region) continue;
		const parsed = parseAsRunnerDoes(region, key);
		const written = tokensWritten(region, key);
		const dropped = written.filter((token) => !parsed.includes(token));
		if (dropped.length > 0) problems.push({file, key, parsed, dropped});
	}
	return problems;
}

/**
 * The cases this check must get right, asserted on every run. The first REJECTING case is the exact
 * shape Prettier produced; if it ever stops being caught, this script says so rather than reporting
 * a board it never really examined.
 */
const SELF_CHECK_CASES = [
	{
		name: 'an inline list the runner reads is accepted',
		lines: ['slug: a', 'blockedBy: [one-slug, another-slug]'],
		expect: [],
	},
	{
		name: 'a block list the runner reads is accepted',
		lines: ['slug: a', 'blockedBy:', '  - one-slug', '  - another-slug', 'covers: []'],
		expect: [],
	},
	{
		name: 'an empty list with the documented trailing comment is accepted',
		lines: ['slug: a', 'blockedBy: [] # startable now'],
		expect: [],
	},
	{
		name: 'the PRETTIER-WRAPPED flow list is refused, naming every dropped slug',
		lines: ['slug: a', 'blockedBy:', '  [', '    one-slug,', '    another-slug,', '  ]', 'covers: []'],
		expect: [{file: 'x.md', key: 'blockedBy', parsed: [], dropped: ['one-slug', 'another-slug']}],
	},
	{
		name: 'a partially-wrapped flow list is refused for the items past the break',
		lines: ['slug: a', 'blockedBy: [one-slug,', '  another-slug]'],
		expect: [{file: 'x.md', key: 'blockedBy', parsed: [], dropped: ['one-slug', 'another-slug']}],
	},
	{
		name: 'taskedAfter is checked on the same rule',
		lines: ['slug: a', 'taskedAfter:', '  [', '    one-slug,', '  ]'],
		expect: [{file: 'x.md', key: 'taskedAfter', parsed: [], dropped: ['one-slug']}],
	},
];

for (const testCase of SELF_CHECK_CASES) {
	const actual = classifyItem('x.md', testCase.lines);
	if (JSON.stringify(actual) === JSON.stringify(testCase.expect)) continue;
	console.error(`the task-graph check is BROKEN: ${testCase.name}`);
	console.error(`  expected ${JSON.stringify(testCase.expect)}`);
	console.error(`  got      ${JSON.stringify(actual)}`);
	process.exit(1);
}

const REJECTING_CASES = SELF_CHECK_CASES.filter((testCase) => testCase.expect.length > 0).length;

/** Terminal positions: frozen records, never claimable, so never claimable too early. */
const EXEMPT = [/^work\/tasks\/done\//, /^work\/tasks\/cancelled\//, /^work\/specs\/dropped\//];

const tracked = execFileSync('git', ['ls-files', 'work/tasks', 'work/specs'], {encoding: 'utf8'})
	.split('\n')
	.filter(Boolean);
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', 'work/tasks', 'work/specs'], {
	encoding: 'utf8',
})
	.split('\n')
	.filter(Boolean);

// Tracking decides what to SCAN and the working tree decides what EXISTS, which is the rule
// `check-work-refs.mjs` arrived at after an unstaged rename killed it mid-gate.
const files = [...new Set([...tracked, ...untracked])].filter(
	(file) => file.endsWith('.md') && !EXEMPT.some((rule) => rule.test(file)) && existsSync(file),
);

const problems = [];
for (const file of files) {
	const lines = frontmatterOf(await readFile(file, 'utf8'));
	if (!lines) continue;
	problems.push(...classifyItem(file, lines));
}

if (problems.length > 0) {
	console.error(`\n${problems.length} dependency list(s) the runner will read differently:\n`);
	for (const {file, key, parsed, dropped} of problems) {
		console.error(`  ${file}`);
		console.error(`    ${key}: written ${JSON.stringify(dropped)} but the runner reads ${JSON.stringify(parsed)}`);
	}
	console.error(
		`\nThe runner parses exactly two list shapes: inline \`[a, b]\` on the key's own line, or block` +
			` \`- a\` lines. A list long enough for Prettier to wrap becomes a MULTI-LINE FLOW list, which is` +
			` neither, so it silently reads as EMPTY and the item becomes claimable before its blockers land.` +
			` Use the BLOCK form, which Prettier leaves alone:\n\n  ${DEPENDENCY_KEYS[0]}:\n    - one-slug\n    - another-slug\n`,
	);
	process.exit(1);
}

console.log(
	`task graph: every dependency list reads as written (${files.length} items scanned, ` +
		`self-check: ${SELF_CHECK_CASES.length} cases, ${REJECTING_CASES} rejecting)`,
);
