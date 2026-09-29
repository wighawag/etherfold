/**
 * The graduation guard (`check-no-major-graduation.mjs`) run over throwaway git fixtures.
 *
 * Plain `node:test`, not vitest: the guard is a root script with no package around it, and the
 * root `test` script runs this file first (`node --test scripts/`) so the gate and CI both exercise
 * it without either needing a new step.
 *
 * Each case commits a workspace at some versions, rewrites the versions in the working tree the way
 * `changeset version` would, and asserts on the guard's exit code and message.
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-no-major-graduation.mjs');

function git(cwd, ...args) {
	execFileSync('git', args, {cwd, stdio: 'ignore'});
}

function writeManifest(root, dir, manifest) {
	mkdirSync(join(root, dir), {recursive: true});
	writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest, null, '\t') + '\n');
}

/**
 * A git repo whose HEAD holds `packages` (`dir -> manifest`), then `bumps` (`dir -> version`) and
 * `added` (`dir -> manifest`, absent at HEAD) applied to the working tree only. Returns the guard's
 * result, run against that repo.
 */
function runGuardOver(packages, bumps, added = {}) {
	const root = mkdtempSync(join(tmpdir(), 'graduation-guard-'));
	try {
		git(root, 'init', '-q');
		git(root, 'config', 'user.email', 'guard@test.invalid');
		git(root, 'config', 'user.name', 'guard test');
		git(root, 'config', 'commit.gpgsign', 'false');
		for (const [dir, manifest] of Object.entries(packages)) writeManifest(root, dir, manifest);
		git(root, 'add', '-A');
		git(root, 'commit', '-q', '-m', 'fixture');
		for (const [dir, version] of Object.entries(bumps)) {
			writeManifest(root, dir, {...packages[dir], version});
		}
		for (const [dir, manifest] of Object.entries(added)) writeManifest(root, dir, manifest);
		return spawnSync(process.execPath, [GUARD, root], {encoding: 'utf8'});
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
}

const workspace = {
	'packages/graphql': {name: '@etherfold/graphql', version: '0.0.0'},
	'packages/browser': {name: '@etherfold/browser', version: '0.11.0'},
	'platforms/nodejs': {name: '@etherfold/platform-nodejs', version: '0.2.2'},
	'packages/stable': {name: '@etherfold/stable', version: '1.4.0'},
	'platforms/private': {name: '@etherfold/platform-private', version: '0.1.0', private: true},
};

test('passes when every 0.x package stays 0.x (a 0.x minor and patch are fine)', () => {
	const result = runGuardOver(workspace, {
		'packages/graphql': '0.1.0',
		'packages/browser': '0.12.0',
		'platforms/nodejs': '0.2.3',
	});
	assert.equal(result.status, 0, result.stderr);
});

test('passes when nothing moved at all', () => {
	const result = runGuardOver(workspace, {});
	assert.equal(result.status, 0, result.stderr);
});

test('refuses a 0.x package that became 1.0.0, naming it', () => {
	const result = runGuardOver(workspace, {'packages/graphql': '1.0.0', 'packages/browser': '0.12.0'});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /@etherfold\/graphql: 0\.0\.0 -> 1\.0\.0/);
	assert.doesNotMatch(result.stderr, /@etherfold\/browser/);
});

test('refuses a 0.x package that jumped past 1.x, and one under platforms/', () => {
	const result = runGuardOver(workspace, {'platforms/nodejs': '2.0.0'});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /@etherfold\/platform-nodejs: 0\.2\.2 -> 2\.0\.0/);
});

test('lets a package already at or above 1.0.0 take a major', () => {
	const result = runGuardOver(workspace, {'packages/stable': '2.0.0'});
	assert.equal(result.status, 0, result.stderr);
});

test('ignores a private package, which is never published', () => {
	const result = runGuardOver(workspace, {'platforms/private': '1.0.0'});
	assert.equal(result.status, 0, result.stderr);
});

test('ignores a package that does not exist at HEAD (new, so nothing graduated)', () => {
	const result = runGuardOver(workspace, {}, {'packages/new': {name: '@etherfold/new', version: '1.0.0'}});
	assert.equal(result.status, 0, result.stderr);
});
