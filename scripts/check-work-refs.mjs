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

const tracked = execFileSync('git', ['ls-files'], {encoding: 'utf8'}).split('\n').filter(Boolean);
const files = tracked.filter((f) => SCANNED.test(f) && !EXEMPT.some((rule) => rule.test(f)));

/** Every `work/` artifact that exists, indexed by filename, so a MOVE can be named as a move. */
const byName = new Map();
for (const f of tracked) {
	if (f.startsWith('work/') && f.endsWith('.md')) {
		const name = basename(f);
		if (!byName.has(name)) byName.set(name, []);
		byName.get(name).push(f);
	}
}

const broken = [];
for (const file of files) {
	const text = await readFile(file, 'utf8');
	for (const [reference] of [...text.matchAll(REFERENCE)].map((m) => [m[0]])) {
		if (existsSync(reference)) continue;
		const elsewhere = (byName.get(basename(reference)) ?? []).filter((p) => p !== reference);
		broken.push({file, reference, elsewhere});
	}
}

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
console.log(`work/ references: all resolve (${scanned} files scanned, ${byName.size} artifacts indexed)`);
