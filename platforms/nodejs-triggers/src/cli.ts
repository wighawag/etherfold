#!/usr/bin/env node
import {serve} from '@hono/node-server';
import {runCLI} from './commands.js';
import type {NodeConfig} from './config.js';
import {createNodeService} from './service.js';

/** The long-lived half: the loop, and the registration API when the config has a verifier. */
async function serveService(config: NodeConfig, signal: AbortSignal): Promise<void> {
	const {service, close} = await createNodeService(config);
	const server = service.api
		? serve({fetch: service.api.fetch, port: config.api?.port ?? 8787, hostname: config.api?.hostname ?? '127.0.0.1'})
		: undefined;
	if (server) {
		console.log(`registration API on http://${config.api?.hostname ?? '127.0.0.1'}:${config.api?.port ?? 8787}`);
	} else {
		console.log('no verifier configured: the registration API is not served, only global rules fire');
	}
	try {
		await service.run({signal, intervalMs: config.intervalMs ?? 5000});
	} finally {
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		close();
	}
}

const controller = new AbortController();
for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => controller.abort());

runCLI(process.argv.slice(2), {
	stdout: (line) => console.log(line),
	stderr: (line) => console.error(line),
	serve: serveService,
	signal: controller.signal,
}).then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	},
);
