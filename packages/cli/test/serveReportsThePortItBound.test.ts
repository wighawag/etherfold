import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer, type RunningServer} from '@etherfold/platform-nodejs';
import {afterEach, describe, expect, it} from 'vitest';
import {serve} from '../src/serve.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold serve --host 127.0.0.1 --port 0` PRINTS A URL AN OPERATOR CAN OPEN
// ---------------------------------------------------------------------------------------------------
// With a hostname, Node binds asynchronously, so a port read straight off the
// server is still the `0` that was asked for and the printed URL answers nothing.
// This runs the command's own flag resolution into the real Node adapter, and
// reads the port back out of the line it prints.
// ---------------------------------------------------------------------------------------------------

const directories: string[] = [];
const servers: RunningServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
	for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('`etherfold serve` reports the port it bound', () => {
	it('prints a non-zero port for `--host 127.0.0.1 --port 0`, and that URL answers', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'etherfold-serve-port-'));
		directories.push(directory);
		const said: string[] = [];
		await serve(
			{db: `file:${join(directory, 'empty.db')}`, host: '127.0.0.1', port: '0'},
			{
				env: {},
				log: (...args) => said.push(args.map(String).join(' ')),
				startServer: async (options) => {
					const running = await startServer(options);
					servers.push(running);
					return running;
				},
			},
		);

		const listening = said.find((line) => line.startsWith('etherfold server listening on '));
		const port = Number(/^etherfold server listening on http:\/\/127\.0\.0\.1:(\d+)$/.exec(listening ?? '')?.[1]);
		expect(port).toBeGreaterThan(0);
		expect((await fetch(`http://127.0.0.1:${port}/status`)).status).toBe(200);
	});
});
