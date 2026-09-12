import type {PortCaseName} from './envelope.js';

/**
 * WHAT HAPPENS WHEN THE THING ON THE OTHER SIDE OF THE PORT STOPS EXISTING.
 *
 * Browsers evict workers, so ADR-0082 treats a death as an EXPECTED event with a
 * defined outcome rather than as a failure nobody handled: **tell the app, reject
 * every call in flight with a typed error, restart, and resume.** Each of the
 * four is load-bearing, and this module is the vocabulary for the first two and
 * the policy for the third.
 *
 * Resume is the one that costs nothing to build, and that is not a coincidence:
 * the state is in the store and the cursor is written in the SAME transaction as
 * the block it describes (ADR-0027), so there is no window in which the cursor is
 * ahead of the data and resuming is reading the cursor and carrying on. A
 * restarted host does it by being an ordinary host -- nothing here tells it where
 * to start.
 *
 * ## Three neighbouring words, and they are NOT the same thing
 *
 * - a **death** is the HOST ceasing to exist. Nothing is answering, the port
 *   restarts it, and what a tab loses is the calls that were in flight.
 * - a `HostProgress.failure` is a host that is very much alive and whose DRIVER
 *   stopped on something waiting cannot fix. It still answers reads, so restarting
 *   it would throw away a working store to meet the same refusal again.
 * - a **demotion** (`CONTEXT.md`, and ADR-0078) is a live writer that lost its
 *   CLAIM on the storage and went on answering reads. It is one-way for the
 *   container that took it, and it is the OPPOSITE case from this one: there, the
 *   store moved on without the host; here, the host is gone and the store is
 *   exactly where it was left.
 *
 * The distinction is what keeps the restart safe. A port restarts a host that is
 * NOT ANSWERING, and it kills what it is replacing before it opens a successor
 * (see `IndexerPort.close`), so the two never write at once -- and the writer
 * claim is underneath that as the guarantee rather than the mechanism: a claim
 * does not expire and does not block, so a writer killed mid-block leaves a store
 * the next claim simply takes over, and a corpse that somehow lived is REFUSED at
 * its next mutation (ADR-0075) rather than corrupting anything.
 */

/**
 * HOW A DEATH WAS CONCLUDED.
 *
 * One member, because there is exactly one thing a tab can actually observe: no
 * browser fires an event when it evicts a dedicated worker, `Worker.terminate()`
 * is silent by construction, and `MessagePort`'s `close` event is not on every
 * engine this package ships to. So what a port works from is SILENCE -- it probes
 * a host that has said nothing, and a probe that is not answered is a death.
 *
 * Written as a union rather than as an absence so that a shape which CAN report a
 * death directly (a SharedWorker whose port closes, say) adds a member here
 * instead of a second event beside this one.
 */
export type HostDeathCause = 'unresponsive';

/**
 * A HOST DIED, as the tab is told.
 *
 * Pushed at the app rather than inferred by it, because silence is the worst
 * available outcome: a stalled app and a slow app look identical from the
 * outside, and that is where "is it broken?" reports come from (ADR-0082).
 *
 * It is deliberately NOT a `PortPush`. Every push on the envelope comes FROM the
 * host, and a host that has stopped existing sends nothing -- this is the port's
 * own report about the host, so it is the port's own subscription
 * (`IndexerPort.onHostDeath`).
 */
export type HostDeath = {
	/** HOW the port concluded it. See `HostDeathCause`. */
	readonly cause: HostDeathCause;
	/**
	 * WHICH CONSECUTIVE DEATH THIS IS, counting from 1.
	 *
	 * The number an app renders as "this keeps happening": a host that stays alive
	 * for `settledAfterInSeconds` is SETTLED and the count starts again, so a `3`
	 * here means three deaths in quick succession rather than the third death since
	 * the tab opened.
	 */
	readonly attempt: number;
	/**
	 * Whether the port is starting another host.
	 *
	 * `false` says nobody is coming, which is the state an app most needs to be able
	 * to render: either the restart budget is spent (a host that only ever dies is
	 * not made well by a fourth try, and a hot restart loop is its own hazard), or
	 * this hosting shape cannot be re-obtained at all.
	 */
	readonly restarting: boolean;
	/** How long the port waits before that restart. Absent where there is none. */
	readonly restartInSeconds?: number;
	/**
	 * HOW MANY CALLS this death rejected: everything that was in flight when it was
	 * concluded.
	 *
	 * Reported because it is the size of what the app has to do something about --
	 * every one of those callers got an `IndexerHostDiedError` and may want to ask
	 * again.
	 */
	readonly rejected: number;
};

/**
 * THE REFUSAL A CALL GETS WHEN THE HOST DIED UNDER IT.
 *
 * In-flight calls are REJECTED and never silently retried. A hung promise is
 * worse than a rejection, a silent retry hides an event an app may want to know
 * about, and a client that wants to retry can -- most already do (ADR-0082).
 *
 * It is narrowed by CLASS here, unlike every refusal on `PortError`, and the
 * difference is real rather than stylistic: those are raised in the HOST and
 * rebuilt from data on arrival, so their prototype cannot survive the crossing.
 * This one is raised in the tab, by the port, about a host that is not there --
 * nothing about it ever crossed a wire, so `instanceof` is exact. The `name` is
 * pinned all the same, for code that narrows the whole surface one way.
 */
export class IndexerHostDiedError extends Error {
	readonly name = 'IndexerHostDiedError';
	/** WHICH CASE the rejected call was on, so a caller knows what to ask again. */
	readonly case: PortCaseName;

	constructor(
		/** The death that rejected this call, exactly as the app was told about it. */
		readonly death: HostDeath,
		portCase: PortCaseName,
	) {
		super(
			`the indexer host died while the '${portCase}' call was in flight, so it was not answered. ` +
				(death.restarting
					? `A replacement host is starting${
							death.restartInSeconds === undefined ? `` : ` in ${death.restartInSeconds}s`
						}; ask again once it has answered.`
					: `No replacement is being started (this was death ${death.attempt} in a row), so this port holds nothing. ` +
						`Connect to a host again.`),
		);
		// `case` is a reserved word, so it cannot be a constructor parameter and is
		// assigned here instead. The NAME is worth the two lines: a case is what the
		// envelope calls a surface, and this says which one was lost.
		this.case = portCase;
	}
}

/** HOW OFTEN THE PORT CHECKS that its host is still there. */
export type HostWatchOptions = {
	/**
	 * The silence after which the port PROBES, and again after which it concludes a
	 * death. Defaults to five seconds, so a death is noticed within ten.
	 *
	 * A probe is one message and its answer (`ping`), and it is sent only when the
	 * host has said NOTHING for this long: a host that is folding, answering or
	 * pushing is visibly alive and is never probed. That is what keeps this from
	 * being the polling ADR-0082 refuses -- what is polled is LIVENESS, never
	 * STATUS, and an idle tab pays one round trip per interval rather than a report
	 * it did not ask for.
	 */
	readonly everyInSeconds?: number;
};

/** WHAT THE PORT DOES ABOUT A HOST THAT DIED. */
export type HostRestartOptions = {
	/**
	 * How many restarts in a row before the port gives up. Defaults to five.
	 *
	 * Bounded because a restart is its own hazard: a worker that dies on boot,
	 * restarted without a budget, is a hot loop building workers for ever, and the
	 * app is never told anything has gone wrong. `0` never restarts, which leaves
	 * the death REPORTED and the calls rejected -- the other three parts of the
	 * decision are not the restart.
	 */
	readonly attempts?: number;
	/**
	 * How long the port waits before the FIRST restart, in seconds. It DOUBLES per
	 * consecutive death, up to `maxBackoffInSeconds`. Defaults to half a second.
	 *
	 * Not zero, and not a fixed interval: a worker killed by memory pressure that is
	 * rebuilt instantly meets the same pressure, and a fixed interval turns "it
	 * keeps dying" into a steady drum of new workers.
	 */
	readonly backoffInSeconds?: number;
	/** The ceiling that doubling stops at. Defaults to thirty seconds. */
	readonly maxBackoffInSeconds?: number;
	/**
	 * How long a host must stay alive before the consecutive-death count is
	 * FORGOTTEN. Defaults to a minute.
	 *
	 * It is what makes the budget a budget for a CRASH LOOP rather than a lifetime
	 * quota: a tab open all day, whose worker was evicted twice hours apart, has not
	 * spent anything.
	 */
	readonly settledAfterInSeconds?: number;
};

/** What a tab may say about the lifetime of the host it is connecting to. */
export type IndexerPortOptions = {
	/**
	 * How the port notices a death.
	 *
	 * `false` never watches, and then a death is never CONCLUDED: nothing reports it
	 * and a call in flight waits until the tab closes the port. That is the right
	 * answer only where a host cannot die on its own -- the main-thread shape, where
	 * the host IS the tab -- and it is the wrong answer everywhere else, because the
	 * silence it leaves is exactly what ADR-0082 refuses.
	 */
	readonly watch?: HostWatchOptions | false;
	/** What it does about one. `false` never restarts, and is `{attempts: 0}` said out loud. */
	readonly restart?: HostRestartOptions | false;
};

/** The same options with every default filled in, in ONE place. */
export type UsedPortOptions = {
	readonly watch: {readonly everyInSeconds: number} | undefined;
	readonly restart: {
		readonly attempts: number;
		readonly backoffInSeconds: number;
		readonly maxBackoffInSeconds: number;
		readonly settledAfterInSeconds: number;
	};
};

/**
 * Fill in the defaults, in one place, exactly as `resolvePromotionConfig` does
 * for the policy: a second copy of a default is how two runtimes come to disagree
 * about which value an app is running under.
 */
export function resolvePortOptions(options: IndexerPortOptions = {}): UsedPortOptions {
	const restart = options.restart === false ? {attempts: 0} : (options.restart ?? {});
	return {
		watch: options.watch === false ? undefined : {everyInSeconds: options.watch?.everyInSeconds ?? 5},
		restart: {
			attempts: restart.attempts ?? 5,
			backoffInSeconds: restart.backoffInSeconds ?? 0.5,
			maxBackoffInSeconds: restart.maxBackoffInSeconds ?? 30,
			settledAfterInSeconds: restart.settledAfterInSeconds ?? 60,
		},
	};
}

/** How long the port waits before the `attempt`-th restart in a row. */
export function backoffFor(attempt: number, restart: UsedPortOptions['restart']): number {
	return Math.min(restart.maxBackoffInSeconds, restart.backoffInSeconds * 2 ** Math.max(0, attempt - 1));
}
