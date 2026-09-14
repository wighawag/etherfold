#!/usr/bin/env node
/**
 * Refuse a citation that points at a `work/` artifact which is not there.
 *
 * ## Why this exists
 *
 * On 2026-09-03, `a-reconfigure-is-not-an-outage.md` moved from `work/specs/proposed/` to
 * `work/specs/tasked/` in the ordinary course of being tasked. Twelve citations of it across
 * `CONTEXT.md`, ADR-0008, ADR-0033, two spike READMEs, an idea note and `indexer-server-feed.md`
 * kept naming the old path, and every one of them became a dead link the moment the file moved.
 * `format:check`, `check:adr`, `build`, `typecheck` and `test` were all green throughout, because
 * nothing in this repo has ever looked at whether a path written in prose resolves.
 *
 * This is not a typo class. A spec's status folder is EXPECTED to change -- proposed to tasked, task
 * to done -- so the reference rots as a normal consequence of the workflow working. That is what
 * makes it worth a gate rather than a sweep: a sweep fixes the twelve, and the thirteenth appears
 * the next time an item advances. It also decays quietly, because the citing document stays
 * plausible: a reader follows the link, finds nothing, and cannot tell whether the artifact was
 * renamed, retired, or never existed.
 *
 * The same shape had already bitten in a second place: `InvalidationVerdict`'s docstring in
 * `packages/core/src/internal/engine/utils.ts` pointed at
 * `work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`, deleted in `8549133f` when the
 * superseded artifacts were retired. So the check covers `work/notes/` too, not only the status
 * folders.
 *
 * ## What it checks
 *
 * Every `work/{specs,tasks,notes}/<folder>/<slug>.md` path written in a NAVIGABLE surface resolves
 * to a file that exists. When it does not, and the same filename exists under another folder, the
 * report names where it went -- because "it moved" and "it is gone" have different fixes and the
 * whole point is to say which one happened.
 *
 * ## What it deliberately does NOT check
 *
 * Historical and terminal surfaces are exempt, because a dead path is CORRECT in them:
 *
 * - `.changeset/` and `**\/CHANGELOG.md` -- a release note records what was true when it was
 *   written; rewriting it to keep a link alive would falsify the record.
 * - `work/tasks/done/`, `work/tasks/cancelled/`, `work/specs/dropped/` -- terminal bodies are
 *   frozen records of what was asked, not navigation.
 * - `work/notes/observations/` -- an observation whose whole subject is a broken reference has to be
 *   able to quote it. This file's own subject is exactly that, so exempting it is not a convenience.
 * - `archive/` and any untracked build output (`docs/.vitepress/dist/`), which are not source.
 *
 * ## Why it reads the WORKING TREE and not the index
 *
 * `git ls-files` names what is TRACKED, which is the only way to tell source from build output, but
 * every existence question here is asked of the working tree (`existsSync`). Mixing the two is what
 * made this script crash on 2026-09-13: it enumerated the index and then `readFile`d each path, so a
 * rename made in the working tree and not yet staged left a tracked path with no file behind it and
 * the whole gate died with an unhandled `ENOENT` instead of reporting anything
 * (`work/notes/observations/check-refs-crashes-on-an-unstaged-rename.md`). The same mixing had a
 * quieter second failure: the artifact index was built from the index too, so after an unstaged move
 * a citation of the old path was reported as "it was deleted" when the file was sitting right there
 * under its new name.
 *
 * So tracking decides what to SCAN, and the working tree decides what EXISTS. An artifact that is
 * present but not yet staged counts as present, because a human looking at their own checkout can
 * see it, and a tracked path with nothing behind it is skipped and COUNTED rather than being either
 * a crash or a silent omission.
 */

import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';

/** `work/<bucket>/<folder>/<slug>.md`, the shape every in-repo citation of an artifact takes. */
const REFERENCE = /work\/(?:specs|tasks|notes)\/[a-z0-9-]+\/[a-z0-9._-]+\.md/g;

const EXEMPT = [
	/^\.changeset\//,
	/CHANGELOG\.md$/,
	/^work\/tasks\/done\//,
	/^work\/tasks\/cancelled\//,
	/^work\/specs\/dropped\//,
	/^work\/notes\/observations\//,
	/^archive\//,
	/^scripts\/check-work-refs\.mjs$/,
];

const SCANNED = /\.(md|ts|mts|js|mjs|json|yml|yaml)$/;

/**
 * Index the `work/` artifacts that EXIST by filename, so a MOVE can be named as a move.
 *
 * Pure, over a list of paths, so the move-versus-deletion report can be asserted below without
 * building a git tree to produce each case.
 */
function indexArtifacts(paths) {
	const byName = new Map();
	for (const path of paths) {
		if (!path.startsWith('work/') || !path.endsWith('.md')) continue;
		const name = basename(path);
		if (!byName.has(name)) byName.set(name, []);
		byName.get(name).push(path);
	}
	return byName;
}

/**
 * The verdict half of the check, as a pure function: which citations point at nothing, and for each
 * one whether the artifact MOVED (it exists under another folder) or is GONE.
 *
 * `exists` is asked of the working tree by the caller, which is the whole reason this is separable:
 * the interesting cases are states of somebody's checkout that CI never reproduces.
 */
function classifyCitations(citations, exists, byName) {
	const broken = [];
	for (const {file, reference} of citations) {
		if (exists(reference)) continue;
		const elsewhere = (byName.get(basename(reference)) ?? []).filter((p) => p !== reference);
		broken.push({file, reference, elsewhere});
	}
	return broken;
}

/**
 * The cases the two pure halves must get right, including the two that must REJECT. Asserted on
 * every run: if one of these ever passes, the check is broken and says so instead of reporting a
 * `work/` tree it never really examined.
 *
 * The last two are the states that made this script crash and then misreport. They are here rather
 * than in a test file because they are shapes of somebody's working tree, which CI never has.
 */
const SELF_CHECK_CASES = [
	{
		name: 'a citation of an artifact that is there resolves',
		present: ['work/specs/tasked/a-thing.md'],
		citations: [{file: 'CONTEXT.md', reference: 'work/specs/tasked/a-thing.md'}],
		expect: [],
	},
	{
		name: 'a citation of an artifact that MOVED folder is named as a move',
		present: ['work/specs/tasked/a-thing.md'],
		citations: [{file: 'CONTEXT.md', reference: 'work/specs/proposed/a-thing.md'}],
		expect: [
			{file: 'CONTEXT.md', reference: 'work/specs/proposed/a-thing.md', elsewhere: ['work/specs/tasked/a-thing.md']},
		],
	},
	{
		name: 'a citation of an artifact that is GONE names nowhere',
		present: ['work/specs/tasked/something-else.md'],
		citations: [{file: 'CONTEXT.md', reference: 'work/notes/ideas/retired.md'}],
		expect: [{file: 'CONTEXT.md', reference: 'work/notes/ideas/retired.md', elsewhere: []}],
	},
	{
		name: 'an UNSTAGED move is a move: the destination counts as present even though git does not track it yet',
		present: ['work/tasks/done/built.md'],
		citations: [{file: 'CONTEXT.md', reference: 'work/tasks/ready/built.md'}],
		expect: [{file: 'CONTEXT.md', reference: 'work/tasks/ready/built.md', elsewhere: ['work/tasks/done/built.md']}],
	},
	{
		name: 'a citation pointing at a path that exists only in the index, not on disk, is BROKEN rather than a crash',
		present: [],
		citations: [{file: 'CONTEXT.md', reference: 'work/tasks/ready/renamed-away.md'}],
		expect: [{file: 'CONTEXT.md', reference: 'work/tasks/ready/renamed-away.md', elsewhere: []}],
	},
];

function runSelfCheck() {
	for (const testCase of SELF_CHECK_CASES) {
		const present = new Set(testCase.present);
		const actual = classifyCitations(testCase.citations, (path) => present.has(path), indexArtifacts(testCase.present));
		if (JSON.stringify(actual) === JSON.stringify(testCase.expect)) continue;
		console.error(`the work/ reference check is BROKEN: ${testCase.name}`);
		console.error(`  expected ${JSON.stringify(testCase.expect)}`);
		console.error(`  got      ${JSON.stringify(actual)}`);
		process.exit(1);
	}
}

runSelfCheck();

/** Counted rather than written down, because a number about itself is the kind of claim that rots. */
const REJECTING_CASES = SELF_CHECK_CASES.filter((testCase) => testCase.expect.length > 0).length;

const gitLines = (args) => execFileSync('git', args, {encoding: 'utf8'}).split('\n').filter(Boolean);

const tracked = gitLines(['ls-files']);
/** Present but not yet staged: a rename's destination is real to whoever is looking at it. */
const untracked = gitLines(['ls-files', '--others', '--exclude-standard']);

const scannable = tracked.filter((f) => SCANNED.test(f) && !EXEMPT.some((rule) => rule.test(f)));
/**
 * A tracked path with no file behind it is an unstaged delete or the source half of an unstaged
 * rename. It is skipped rather than read, because reading it is the `ENOENT` that used to kill the
 * gate, and counted rather than dropped silently, because a file that went unscanned is a file whose
 * citations went unchecked.
 */
const files = scannable.filter((f) => existsSync(f));
const unreadable = scannable.length - files.length;

const byName = indexArtifacts([...tracked, ...untracked].filter((f) => existsSync(f)));

const citations = [];
for (const file of files) {
	const text = await readFile(file, 'utf8');
	for (const match of text.matchAll(REFERENCE)) citations.push({file, reference: match[0]});
}

const broken = classifyCitations(citations, (path) => existsSync(path), byName);

if (broken.length > 0) {
	console.error(`\n${broken.length} dead work/ reference(s):\n`);
	for (const {file, reference, elsewhere} of broken) {
		console.error(`  ${file}`);
		console.error(`    -> ${reference}`);
		console.error(
			elsewhere.length > 0
				? `       MOVED to ${elsewhere.join(', ')} -- update the citation`
				: `       NOT FOUND anywhere under work/ -- it was deleted, so cite what replaced it or drop the pointer`,
		);
	}
	console.error(
		`\nA status-folder move is normal, so a citation of a work/ artifact has to be updated with it.` +
			` If the reference is HISTORICAL rather than navigational, the surface holding it probably belongs` +
			` in this check's exempt list (see the header) rather than being reworded.\n`,
	);
	process.exit(1);
}

const scanned = files.length;
console.log(
	`work/ references: all resolve (${scanned} files scanned, ${byName.size} artifacts indexed` +
		`${unreadable > 0 ? `, ${unreadable} tracked path(s) skipped as absent from the working tree` : ''}` +
		`, self-check: ${SELF_CHECK_CASES.length} cases, ${REJECTING_CASES} rejecting)`,
);
