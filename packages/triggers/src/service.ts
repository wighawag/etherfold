import type {RemoteSQL} from 'remote-sql';
import {createConsumer, type Consumer, type Lane} from './consumer.js';
import {
	assertActionsFitLane,
	createDeliverer,
	type ActionAdapter,
	type Deliverer,
	type DeliveryReport,
} from './delivery.js';
import type {CanonicalFeed} from './feed.js';
import {createRegistrationAPI, type RegistrationVerifier} from './registration.js';
import {createTriggerRegistry, defineTriggers, type TriggerDefinitions, type TriggerRegistry} from './triggers.js';

// ---------------------------------------------------------------------------
// THE TRIGGER SERVICE, composed: one consumer over one named indexer, its
// trigger registry, its deliverer, and (when a verifier is given) the
// registration API. A platform (the nodejs CLI) adds a database, a gate and a
// server around it; nothing here opens a port or reads the environment.
// ---------------------------------------------------------------------------

export type TriggerServiceOptions = {
	db: RemoteSQL;
	/** The consumer's name; also the `consumer` of every delivery. */
	name: string;
	chainId: string;
	feed: CanonicalFeed;
	gate: () => Promise<number>;
	definitions: TriggerDefinitions;
	actions: Record<string, ActionAdapter>;
	/** Without one, nobody can register: only global rules fire. */
	verifier?: RegistrationVerifier;
	lane?: Lane;
	limit?: number;
	maxSubscriptionsPerRecipient?: number;
	clock?: () => number;
};

export type TickReport = {
	expired: number;
	consumed: number;
	matched: number;
	paused: boolean;
	delivery: DeliveryReport;
};

export type TriggerService = {
	consumer: Consumer;
	registry: TriggerRegistry;
	deliverer: Deliverer;
	/** The registration API (a Hono app), when a verifier was given. */
	api: ReturnType<typeof createRegistrationAPI> | undefined;
	setup(): Promise<void>;
	/** One round: expire what is due, follow the feed to the gate, attempt what is due. */
	tick(): Promise<TickReport>;
	/** Tick until the signal aborts, waiting `intervalMs` between rounds; a failed round is reported and retried. */
	run(options: {signal?: AbortSignal; intervalMs?: number; onError?: (error: unknown) => void}): Promise<void>;
};

export function createTriggerService(options: TriggerServiceOptions): TriggerService {
	const lane = options.lane ?? 'safe';
	const definitions = defineTriggers(options.definitions);
	assertActionsFitLane(definitions, options.actions, lane);
	const clock = options.clock ?? Date.now;

	const registry = createTriggerRegistry({
		db: options.db,
		definitions,
		clock,
		...(options.maxSubscriptionsPerRecipient === undefined
			? {}
			: {maxSubscriptionsPerRecipient: options.maxSubscriptionsPerRecipient}),
	});
	const consumer = createConsumer({
		db: options.db,
		name: options.name,
		chainId: options.chainId,
		feed: options.feed,
		gate: options.gate,
		match: registry.matcher(),
		lane,
		clock,
		...(options.limit === undefined ? {} : {limit: options.limit}),
	});
	const deliverer = createDeliverer({db: options.db, actions: options.actions, clock});
	const api = options.verifier ? createRegistrationAPI({registry, verifier: options.verifier}) : undefined;

	async function tick(): Promise<TickReport> {
		const expired = await registry.expire();
		// a feed that is down must not hold back what is already in the outbox: deliver either way,
		// then report the feed's failure
		let followed: Awaited<ReturnType<Consumer['catchUp']>> | undefined;
		let failure: unknown;
		try {
			followed = await consumer.catchUp();
		} catch (error) {
			failure = error;
		}
		const delivery = await deliverer.deliverDue();
		if (!followed) throw failure;
		return {
			expired,
			consumed: followed.entries,
			matched: followed.deliveries,
			paused: followed.last.kind === 'paused',
			delivery,
		};
	}

	return {
		consumer,
		registry,
		deliverer,
		api,
		setup: () => registry.setup(),
		tick,
		async run({
			signal,
			intervalMs = 5000,
			onError = (error) => console.error('trigger service: a round failed', error),
		}) {
			while (!signal?.aborted) {
				try {
					await tick();
				} catch (error) {
					onError(error);
				}
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, intervalMs);
					signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), {once: true});
				});
			}
		},
	};
}
