import {parseArgs} from 'node:util';
import {listDeliveries, readJournal, type DeliveryStatus, type JournalKind} from '@etherfold/triggers';
import {loadConfig, type NodeConfig} from './config.js';
import {createNodeService, type NodeApp} from './service.js';

export const USAGE = `etherfold-triggers <command> [--app <name>] [--config <file>]

Commands (every app of the config, or the one --app names, except run; each JSON line names its app):
  run                      every app's loop, and their registration APIs under /{app}/ (until SIGINT/SIGTERM)
  tick                     one round of each app (expire, follow the feed to the gate, deliver what is due) under
                           its lease, then release the lease and exit (another ticker's: "lease": "not-leased")
  status                   each app's consumer position, and why it is paused if it is
  resume                   an operator's decision after a pause: follow the new generation or stream
                           (without --app: the one paused app, refused when several are)
  deliveries [--status s]  the outbox (pending, delivered, expired, dead, retracted), as JSON lines
  requeue <id>             put a dead letter back in the queue (refused when the row is not --app's)
  journal [--kind k]       what happened that an operator must see (rewind, paused, expired, dead-lettered, ...)

Options:
  --app <name>     act on, or report, that app of the config only (not with run)
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
		options: {
			config: {type: 'string'},
			app: {type: 'string'},
			status: {type: 'string'},
			kind: {type: 'string'},
			help: {type: 'boolean'},
		},
	});
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		io.stdout(USAGE);
		return command || values.help ? 0 : 1;
	}
	const config = await (io.loadConfig ?? loadConfig)(values.config ?? 'triggers.config.js');

	if (command === 'run') {
		if (values.app !== undefined) {
			io.stderr(
				'run serves every app of the config; --app is for the operator commands (run a config of that app alone instead)',
			);
			return 1;
		}
		if (!io.serve) throw new Error('run needs a server');
		await io.serve(config, io.signal ?? new AbortController().signal);
		return 0;
	}

	// checked before any database is opened: a typo never sets up a database, or ticks the others
	const names = Object.keys(config.apps);
	if (values.app !== undefined && !names.includes(values.app)) {
		io.stderr(`no app "${values.app}" in this config (its apps: ${names.join(', ')})`);
		return 1;
	}

	const node = await createNodeService(config);
	/** The apps a command covers: the one `--app` names, or every app of the config. */
	const apps: NodeApp[] = Object.values(node.apps).filter((app) => values.app === undefined || app.name === values.app);
	try {
		switch (command) {
			case 'tick': {
				const ticked = apps.map((app) => app.name);
				// a finished one-shot round gives the lease up, so the next one need not wait for it to lapse
				const reports = await node.tick(ticked).finally(() => node.release(ticked));
				for (const report of reports) io.stdout(JSON.stringify(report));
				return reports.some((report) => 'error' in report) ? 1 : 0;
			}
			case 'status':
				for (const app of apps) io.stdout(JSON.stringify(await app.service.consumer.status()));
				return 0;
			case 'resume': {
				let app: NodeApp | undefined = apps[0];
				if (values.app === undefined) {
					// resuming is a decision about ONE app: without --app, only the one paused app is unambiguous
					const paused: NodeApp[] = [];
					for (const candidate of apps) if ((await candidate.service.consumer.status()).paused) paused.push(candidate);
					if (paused.length !== 1) {
						io.stderr(
							paused.length === 0
								? 'no app is paused: there is nothing to resume'
								: `several apps are paused (${paused.map((candidate) => candidate.name).join(', ')}): name one with --app`,
						);
						return 1;
					}
					app = paused[0];
				}
				await app!.service.consumer.resume();
				io.stdout(JSON.stringify(await app!.service.consumer.status()));
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
				// whose row it is, among every app of the config (apps on their own databases may share an id)
				const owners: NodeApp[] = [];
				for (const candidate of Object.values(node.apps)) {
					if ((await listDeliveries(candidate.db, candidate.name, {id})).length > 0) owners.push(candidate);
				}
				const app = owners.find((owner) => values.app === undefined || owner.name === values.app);
				if (!app) {
					io.stderr(
						owners.length === 0
							? `no app of this config has a delivery ${id}`
							: `delivery ${id} belongs to the app ${owners.map((owner) => owner.name).join(', ')}, not ${values.app}: requeue it with --app ${owners[0]!.name}`,
					);
					return 1;
				}
				if (values.app === undefined && owners.length > 1) {
					io.stderr(
						`several apps have a delivery ${id} (${owners.map((owner) => owner.name).join(', ')}): name one with --app`,
					);
					return 1;
				}
				const requeued = await app.service.deliverer.requeue(id);
				if (!requeued) {
					io.stderr(`delivery ${id} of the app ${app.name} is not a dead letter`);
					return 1;
				}
				io.stdout(JSON.stringify({app: app.name, requeued: id}));
				return 0;
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
