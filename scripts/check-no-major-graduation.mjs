#!/usr/bin/env node
/**
 * Refuse to let a pre-1.0 package graduate to `1.x` by accident.
 *
 * ## Why this exists
 *
 * On 2026-09-29 the open Version Packages PR took `@etherfold/graphql` from `0.0.0` to `1.0.0`,
 * although every pending changeset was a patch or a minor. `@etherfold/graphql` peers on
 * `@etherfold/browser` (optional), `@etherfold/browser` took a minor, and `@changesets/cli` v2
 * (`@changesets/assemble-release-plan` 6.x, `shouldBumpMajor`) bumps a PEER-dependent to major on
 * any minor of its peer. Declaring the peer as `workspace:^` did NOT stop it on v2: changesets
 * resolves that to `^0.11.0`, which `0.12.0` is out of, and the major fires anyway.
 *
 * What normally prevents it is **`@changesets/cli` v3**: its `assemble-release-plan` 7.x no longer
 * has the peer-dependent major rule, so the same changesets give `@etherfold/graphql` `0.1.0`. That
 * is the same fix `wighawag/rocketh` runs on (its own guard credits `workspace:^`, which is wrong).
 * The internal peer is still declared `workspace:^` so it PUBLISHES as a `^x.y.z` range rather than
 * an exact pin, but that is about the published manifest, not about this bump.
 *
 * This guard is the backstop for when that stops being true (a changesets downgrade, a new rule, a
 * `major` changeset on a 0.x package): the release stops loudly instead of publishing a version
 * nobody chose. A version number can be un-chosen before publish and never after.
 *
 * ## What it checks
 *
 * Every workspace package under `packages/`, `platforms/` and `examples/` that is published (not
 * `private: true`): its version in the working tree against its version at `HEAD`. It fails, naming
 * the package, when the version at `HEAD` was below `1.0.0` and the working tree's is at or above
 * it. A package already at or above `1.0.0` is on real semver and may take a major. A package that
 * does not exist at `HEAD` is new, so it cannot have graduated.
 *
 * Run it AFTER `changeset version` and BEFORE those bumps are committed, which is what the root
 * `changeset:version` script does and what the release workflow's `version-script` calls.
 *
 * Usage: `node scripts/check-no-major-graduation.mjs [root]` (root defaults to `.`).
 * Tested by `scripts/check-no-major-graduation.test.mjs` over throwaway git fixtures.
 */

import {execFileSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.argv[2] ?? '.';

/** The workspace globs a package may live under. Kept in step with `pnpm-workspace.yaml`. */
const PACKAGE_DIRS = ['packages', 'platforms', 'examples'];

function majorOf(version) {
	const major = Number(String(version).split('.')[0]);
	return Number.isNaN(major) ? -1 : major;
}

/** The manifest's version at `HEAD`, i.e. before `changeset version` touched the tree. */
function versionAtHead(root, relativePath) {
	try {
		const raw = execFileSync('git', ['show', `HEAD:./${relativePath}`], {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		return JSON.parse(raw).version;
	} catch {
		return undefined;
	}
}

const graduated = [];
for (const dir of PACKAGE_DIRS) {
	const base = join(ROOT, dir);
	if (!existsSync(base)) continue;
	for (const entry of readdirSync(base, {withFileTypes: true})) {
		if (!entry.isDirectory()) continue;
		const relativePath = `${dir}/${entry.name}/package.json`;
		const manifestPath = join(ROOT, relativePath);
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		if (manifest.private === true || typeof manifest.version !== 'string') continue;

		const before = versionAtHead(ROOT, relativePath);
		if (before === undefined) continue;
		if (majorOf(before) === 0 && majorOf(manifest.version) >= 1) {
			graduated.push({name: manifest.name ?? relativePath, from: before, to: manifest.version});
		}
	}
}

if (graduated.length > 0) {
	console.error('Refusing to graduate a pre-1.0 package to 1.x:\n');
	for (const {name, from, to} of graduated) console.error(`  ${name}: ${from} -> ${to}`);
	console.error(
		[
			'',
			'Nothing here is meant to reach 1.0.0 yet, so this is almost certainly changesets bumping a',
			'peer-dependent rather than a decision anyone made. What normally prevents it is',
			'@changesets/cli v3: v2 bumps a package to major whenever a peer it depends on takes a minor,',
			'and a `workspace:^` peer does NOT stop that on v2. Check that @changesets/cli is still >= 3,',
			'and that no changeset asks for a `major` on a 0.x package.',
			'',
			'If a 1.0.0 IS intended, remove this check in the same commit that says so.',
		].join('\n'),
	);
	process.exit(1);
}

console.log('check-no-major-graduation: no pre-1.0 package graduated to 1.x');
