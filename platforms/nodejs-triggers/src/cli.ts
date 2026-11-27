#!/usr/bin/env node
import {serve} from '@hono/node-server';
import {runCLI} from './commands.js';
import type {NodeConfig} from './config.js';
import {createNodeService} from './service.js';

/** The long-lived half: every app's loop, and the registration APIs of the apps with a verifier. */
async function serveService(config: NodeConfig, signal: AbortSignal): Promise<void> {
	const node = await createNodeService(config);
	const port = config.api?.port ?? 8787;
	const hostname = config.api?.hostname ?? '127.0.0.1';
	const server = node.api ? serve({fetch: node.api.fetch, port, hostname}) : undefined;
	for (const app of Object.values(node.apps)) {
		console.log(
			app.service.api
				? `${app.name}: registration API on http://${hostname}:${port}/${app.name}/subscriptions`
				: `${app.name}: no verifier configured, so no registration API: only global rules fire`,
		);
	}
	try {
		await node.run({signal, intervalMs: config.intervalMs ?? 5000});
	} finally {
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		node.close();
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
