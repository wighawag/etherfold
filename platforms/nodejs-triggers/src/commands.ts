import {parseArgs} from 'node:util';
import {listDeliveries, readJournal, type DeliveryStatus, type JournalKind} from '@etherfold/triggers';
import {loadConfig, type NodeConfig} from './config.js';
import {createNodeService, type NodeApp} from './service.js';

export const USAGE = `etherfold-triggers <command> [--config <file>]

Commands (every app of the config, each JSON line naming its app):
  run                      every app's loop, and their registration APIs under /{app}/ (until SIGINT/SIGTERM)
  tick                     one round of every app (expire, follow the feed to the gate, deliver what is due), then exit
  status                   each app's consumer position, and why it is paused if it is
  resume                   an operator's decision after a pause: follow the new generation or stream (one app only)
  deliveries [--status s]  the outbox (pending, delivered, expired, dead, retracted), as JSON lines
  requeue <id>             put a dead letter back in the queue (one app only)
  journal [--kind k]       what happened that an operator must see (rewind, paused, expired, dead-lettered, ...)

Options:
  --config <file>  the service's config module (default: ./triggers.config.js)
`;

export type IO = {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
	/** Runs the long-lived service (the server and the loop); the `run` command only. */
	serve?: (config: NodeConfig, signal: AbortSignal) => Promise<void>;
	signal?: AbortSignal;
	loadConfig?: (path: string) => Promise<NodeConfig>;
};

/** The CLI, with its output and its long-running half injected so every other command is testable. */
export async function runCLI(argv: string[], io: IO): Promise<number> {
	const {values, positionals} = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {config: {type: 'string'}, status: {type: 'string'}, kind: {type: 'string'}, help: {type: 'boolean'}},
	});
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		io.stdout(USAGE);
		return command || values.help ? 0 : 1;
	}
	const config = await (io.loadConfig ?? loadConfig)(values.config ?? 'triggers.config.js');

	if (command === 'run') {
		if (!io.serve) throw new Error('run needs a server');
		await io.serve(config, io.signal ?? new AbortController().signal);
		return 0;
	}

	const node = await createNodeService(config);
	const apps = Object.values(node.apps);
	/**
	 * The one app an operator's action acts on. Until the CLI takes `--app`, an action on a config
	 * of several apps is refused: resuming every paused app at once is not a decision anyone made.
	 */
	const onlyApp = (action: string): NodeApp | undefined => {
		if (apps.length === 1) return apps[0];
		io.stderr(
			`${action} acts on one app, and this config declares several apps (${apps.map((app) => app.name).join(', ')}): run it with a config of that app alone`,
		);
		return undefined;
	};
	try {
		switch (command) {
			case 'tick': {
				const reports = await node.tick();
				for (const report of reports) io.stdout(JSON.stringify(report));
				return reports.some((report) => 'error' in report) ? 1 : 0;
			}
			case 'status':
				for (const app of apps) io.stdout(JSON.stringify(await app.service.consumer.status()));
				return 0;
			case 'resume': {
				const app = onlyApp('resume');
				if (!app) return 1;
				await app.service.consumer.resume();
				io.stdout(JSON.stringify(await app.service.consumer.status()));
				return 0;
			}
			case 'deliveries':
				for (const app of apps) {
					for (const delivery of await listDeliveries(
						app.db,
						app.name,
						values.status ? {status: values.status as DeliveryStatus} : {},
					)) {
						io.stdout(JSON.stringify(delivery));
					}
				}
				return 0;
			case 'requeue': {
				const id = Number(rest[0]);
				if (!Number.isInteger(id)) {
					io.stderr('requeue <id>: the id of a dead delivery');
					return 1;
				}
				const app = onlyApp('requeue');
				if (!app) return 1;
				const requeued = await app.service.deliverer.requeue(id);
				if (!requeued) io.stderr(`delivery ${id} is not a dead letter`);
				return requeued ? 0 : 1;
			}
			case 'journal':
				for (const app of apps) {
					for (const entry of await readJournal(
						app.db,
						app.name,
						values.kind ? {kind: values.kind as JournalKind} : {},
					)) {
						io.stdout(JSON.stringify(entry));
					}
				}
				return 0;
			default:
				io.stderr(`unknown command "${command}"\n\n${USAGE}`);
				return 1;
		}
	} finally {
		node.close();
	}
}
