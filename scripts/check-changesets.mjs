#!/usr/bin/env node
/**
 * Refuse a changeset that names a PRIVATE package beside a published one, before the expensive
 * part of the gate runs.
 *
 * ## Why this exists
 *
 * On 2026-09-10, `the-cli-schedules-the-prune-its-retention-implies` was built, gated and bounced
 * for a single frontmatter line: its changeset listed `@etherfold/platform-cf-worker: patch`
 * alongside `@etherfold/state-store` and `etherfold`, because the change had touched a docstring
 * under `platforms/cf-worker/`. `@changesets/assemble-release-plan` refuses any changeset spanning
 * ignored and not-ignored packages, so `pnpm changeset status --since=main` failed with "Mixed
 * changesets that contain both ignored and not ignored packages are not allowed".
 *
 * The work itself was fine. What made it expensive is WHERE it failed: `changeset status` sits
 * inside the acceptance gate, which runs after a full `pnpm install` and a complete agent build, so
 * a one-line mistake cost the entire run. And it is an easy mistake to make honestly, because the
 * rule is invisible at the point of authoring: `.changeset/config.json` sets `"ignore": []`, so
 * nothing in the file says `@etherfold/platform-cf-worker` is ignored. It is ignored because it is
 * `private: true` and `privatePackages: false`, two facts in two other files.
 *
 * A private package needs no changeset entry at all: it is never published, so there is no version
 * to bump and nothing for a consumer to read. The fix is always to DELETE the line, never to split
 * the changeset in two.
 *
 * ## What it checks
 *
 * Every `.changeset/*.md` frontmatter, against the workspace:
 *
 * - a package that is `private: true` (while `privatePackages` is not enabled) named in ANY
 *   changeset, which is the mixed-changeset failure above and also pointless on its own;
 * - a package name that matches no workspace package at all, which `changeset status` reports far
 *   less directly and is usually a typo or a rename that a changeset was not updated for.
 *
 * It deliberately does NOT re-implement release planning. `changeset status` stays in the gate and
 * remains the authority; this only moves the cheapest and most common refusal to the front, where
 * it costs a second instead of an hour.
 */

import {readdirSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.argv[2] ?? '.';
const CHANGESET_DIR = join(ROOT, '.changeset');

/** The workspace globs a package may live under. Kept in step with `pnpm-workspace.yaml`. */
const PACKAGE_DIRS = ['packages', 'platforms', 'examples'];

/**
 * Read the frontmatter package list of a changeset.
 *
 * A changeset's frontmatter is `'name': bump` lines between `---` fences. Parsed narrowly on
 * purpose: anything this does not recognise is left to `changeset status`, which is the authority.
 */
export function packagesNamedIn(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match) return [];
	const names = [];
	for (const line of match[1].split(/\r?\n/)) {
		const entry = /^\s*['"]?(@?[^'":]+)['"]?\s*:\s*(major|minor|patch)\s*$/.exec(line);
		if (entry) names.push(entry[1].trim());
	}
	return names;
}

/** Every workspace package, as `name -> {private}`. */
function workspacePackages(root) {
	const found = new Map();
	for (const dir of PACKAGE_DIRS) {
		const base = join(root, dir);
		if (!existsSync(base)) continue;
		for (const entry of readdirSync(base, {withFileTypes: true})) {
			if (!entry.isDirectory()) continue;
			const manifest = join(base, entry.name, 'package.json');
			if (!existsSync(manifest)) continue;
			const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
			if (typeof pkg.name === 'string') found.set(pkg.name, {private: pkg.private === true});
		}
	}
	return found;
}

const config = existsSync(join(CHANGESET_DIR, 'config.json'))
	? JSON.parse(readFileSync(join(CHANGESET_DIR, 'config.json'), 'utf8'))
	: {};
// `privatePackages: true` (or an object) means private packages ARE versioned, so naming one is legal.
const privatePackagesVersioned = config.privatePackages !== false && config.privatePackages !== undefined;

if (!existsSync(CHANGESET_DIR)) {
	console.log(`${CHANGESET_DIR}: no such directory, nothing to check`);
	process.exit(0);
}

const workspace = workspacePackages(ROOT);
const files = readdirSync(CHANGESET_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md');

const problems = [];
for (const file of files) {
	const named = packagesNamedIn(readFileSync(join(CHANGESET_DIR, file), 'utf8'));
	for (const name of named) {
		const pkg = workspace.get(name);
		if (pkg === undefined) {
			problems.push({file, name, why: 'names no package in this workspace (a typo, or a rename)'});
		} else if (pkg.private && !privatePackagesVersioned) {
			problems.push({
				file,
				name,
				why: 'is `private: true`, so changesets IGNORES it and refuses any changeset that also names a published package',
			});
		}
	}
}

for (const {file, name, why} of problems) {
	console.error(`.changeset/${file}: \`${name}\` ${why}`);
}

if (problems.length > 0) {
	console.error(
		'\nA private package is never published, so it needs no changeset entry: DELETE the line rather than\n' +
			'splitting the changeset in two. This check exists so the refusal costs a second here instead of a\n' +
			'full build followed by `changeset status` failing at the end of the gate.',
	);
	process.exit(1);
}

console.log(`.changeset: ${files.length} changesets, every named package is a published workspace package`);
