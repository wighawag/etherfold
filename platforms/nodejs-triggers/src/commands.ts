import {parseArgs} from 'node:util';
import {listDeliveries, readJournal, type DeliveryStatus, type JournalKind} from '@etherfold/triggers';
import {loadConfig, type NodeConfig} from './config.js';
import {createNodeService} from './service.js';

export const USAGE = `etherfold-triggers <command> [--config <file>]

Commands:
  run                      follow the feed, deliver, and serve the registration API (until SIGINT/SIGTERM)
  tick                     one round (expire, follow the feed to the gate, deliver what is due), then exit
  status                   the consumer's app and position, and why it is paused if it is
  resume                   an operator's decision after a pause: follow the new generation or stream
  deliveries [--status s]  the outbox (pending, delivered, expired, dead, retracted), as JSON lines
  requeue <id>             put a dead letter back in the queue
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

	const {service, db, close} = await createNodeService(config);
	try {
		switch (command) {
			case 'tick':
				io.stdout(JSON.stringify(await service.tick()));
				return 0;
			case 'status':
				io.stdout(JSON.stringify(await service.consumer.status()));
				return 0;
			case 'resume':
				await service.consumer.resume();
				io.stdout(JSON.stringify(await service.consumer.status()));
				return 0;
			case 'deliveries':
				for (const delivery of await listDeliveries(
					db,
					service.app,
					values.status ? {status: values.status as DeliveryStatus} : {},
				)) {
					io.stdout(JSON.stringify(delivery));
				}
				return 0;
			case 'requeue': {
				const id = Number(rest[0]);
				if (!Number.isInteger(id)) {
					io.stderr('requeue <id>: the id of a dead delivery');
					return 1;
				}
				const requeued = await service.deliverer.requeue(id);
				if (!requeued) io.stderr(`delivery ${id} is not a dead letter`);
				return requeued ? 0 : 1;
			}
			case 'journal':
				for (const entry of await readJournal(db, service.app, values.kind ? {kind: values.kind as JournalKind} : {})) {
					io.stdout(JSON.stringify(entry));
				}
				return 0;
			default:
				io.stderr(`unknown command "${command}"\n\n${USAGE}`);
				return 1;
		}
	} finally {
		close();
	}
}
