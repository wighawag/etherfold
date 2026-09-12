import type {Abi, IndexingSource, TxInclusionQuery, TxInclusionVerdict, UsedPromotionConfig} from '@etherfold/core';
import {logs} from 'named-logs';
import {assertClonable} from './clone.js';
import {listen, type HostAccess} from './endpoint.js';
import {
	INDEXER_PORT_PROTOCOL,
	isPortPush,
	isPortResponse,
	type HostGeneration,
	type HostProgress,
	type HostReconfigure,
	type HostingShape,
	type PortCaseName,
	type PortRequest,
	type PortRequestPayload,
	type PortResponseValue,
} from './envelope.js';
import {errorFromPort} from './errors.js';
import type {PortStateReads} from './reads.js';
import {
	backoffFor,
	IndexerHostDiedError,
	resolvePortOptions,
	type HostDeath,
	type IndexerPortOptions,
} from './restart.js';

const namedLogger = logs('@etherfold/browser');

/**
 * THE PORT: the typed boundary a tab holds onto a host that is not its own
 * thread.
 *
 * Every verb here is a CASE on the envelope, except `onProgress`, which is the
 * one thing that travels the other way: a PUSH the host sends unprompted
 * (ADR-0082). What is not here is as much the point as what is: a tab holds no
 * store, no container and no processor, so there is nothing on this type that
 * could mutate the state the host is folding into. The writer/reader split
 * (ADR-0077, ADR-0079) reaches across the boundary as a fact of the TYPE rather
 * than as a rule anybody has to remember -- the host opened the store for
 * WRITING, and what a tab can name is this.
 *
 * What a tab reads WITH is `reads` below: the store's four reads, proxied, with
 * nothing beside them that could write. A tab may also open the same store for
 * READING itself (`openForReading`), which the same-origin IndexedDB default
 * makes possible -- the port is what makes the surface work for a store a tab
 * cannot open, and what keeps an app from having to know which of the two it is
 * in.
 */
export type IndexerPort = {
	/** WHICH hosting shape this port leads to, as the access that built it named it. */
	readonly host: HostingShape;
	/**
	 * How far the host's fold has got.
	 *
	 * Answering at all is proof the host is ALIVE, which is why nothing here says
	 * so separately. A host that has stopped reports why in `failure` instead of
	 * leaving a tab to infer it from a number that stopped moving.
	 */
	progress(): Promise<HostProgress>;
	/**
	 * BE TOLD where the fold has got to, whenever it MOVES. Returns the detach.
	 *
	 * This is the channel ADR-0082 decides on: status is PUSHED, and an app builds
	 * whatever reactive wrapper its framework wants over this signal --
	 * `createProgressReadable(port)` is the one this package ships for the common
	 * case. Nothing here polls, and nothing on a timer moves it: the host posts
	 * when a batch has been APPLIED or the phase changed, and posts nothing when
	 * the report would repeat the last one.
	 *
	 * ```ts
	 * const stop = indexer.onProgress(({phase, blocksBehindTip}) => {
	 *   banner.textContent = phase === 'at-tip' ? 'live' : `syncing, ${blocksBehindTip} blocks behind`;
	 * });
	 * ```
	 *
	 * The listener is called with WHERE THE FOLD IS NOW as soon as the host
	 * answers, so a tab that attached half way through a fold renders the truth
	 * without waiting for the next batch to land.
	 *
	 * A SUBSCRIPTION and not a slot: several listeners may hold it at once, and
	 * each releases its own -- unlike the container's `onLastSyncUpdated` and its
	 * neighbours, which are single assignable callbacks on an object only the host
	 * can reach. When the LAST one lets go, the host is told to stop posting, so an
	 * unsubscribed tab stops receiving pushes rather than merely ignoring them.
	 */
	onProgress(listener: (progress: HostProgress) => void): () => void;
	/**
	 * BE TOLD THAT THE HOST DIED. Returns the detach.
	 *
	 * Browsers evict workers, so this is an expected event with a defined outcome
	 * rather than a failure nobody handled (ADR-0082): the app is TOLD, every call in
	 * flight rejects with an `IndexerHostDiedError`, the port starts another host, and
	 * the fold resumes from the cursor the store already holds (ADR-0027). Nothing is
	 * lost but the questions that were in the air.
	 *
	 * ```ts
	 * indexer.onHostDeath(({attempt, restarting}) => {
	 *   banner.textContent = restarting ? 'the indexer restarted' : `the indexer keeps failing (${attempt} times)`;
	 * });
	 * ```
	 *
	 * AN EVENT rather than something to infer, because silence is the worst
	 * available outcome: a stalled app and a slow app look identical from outside,
	 * and that is where "is it broken?" reports come from. Nothing polls for it --
	 * the port watches the host (`IndexerPortOptions.watch`) and tells whoever asked.
	 *
	 * It is NOT `HostProgress.failure`, and the difference decides what an app should
	 * do: a failure is a host that is alive and whose DRIVER stopped on something
	 * waiting cannot fix, so it still answers reads. This is the host being gone.
	 */
	onHostDeath(listener: (death: HostDeath) => void): () => void;
	/**
	 * START INDEXING, and answer where the fold is now.
	 *
	 * What a settings screen turns back on. Asking a host that is already indexing
	 * is an ANSWER rather than a refusal, because this names a STATE and not an
	 * edge: two components that each ask once leave the host in the state they both
	 * asked for.
	 */
	startIndexing(): Promise<HostProgress>;
	/**
	 * STOP INDEXING, and answer where the fold stopped.
	 *
	 * What a backgrounded tab or a settings screen calls so an app stops burning a
	 * user's rate limit. It RESOLVES WHEN THE CYCLE IN FLIGHT HAS LANDED, so a
	 * caller that has been answered knows no further chain request will be made and
	 * that the cursor is where a completed cycle would have left it -- a stopped
	 * indexer resumes without re-indexing and without skipping.
	 *
	 * Stopping a host that is not indexing answers where it is and changes nothing.
	 */
	stopIndexing(): Promise<HostProgress>;
	/**
	 * RECONFIGURE THE SOURCE, and be told what that produced.
	 *
	 * A reconfigure is not an outage: the new generation folds BESIDE the live one,
	 * which goes on answering every read until the promotion policy moves the
	 * **canonical pointer** (`promotion()` reports which policy is in force). Nothing
	 * is discarded, and a source whose hashable shape did not move resolves to the
	 * generation that is already running rather than rebuilding anything
	 * (`HostReconfigure.added`).
	 *
	 * ```ts
	 * const {generation, added} = await indexer.reconfigure({source: nextSource});
	 * if (added && !generation.follows) banner.textContent = 'refetching this contract\u2019s history';
	 * ```
	 *
	 * The SOURCE is the only half of a generation that can cross: the fold is code,
	 * so changing it is a new worker bundle rather than a message (ADR-0082).
	 * A REFUSAL -- the generation caps, which is the one this call meets -- rejects
	 * it carrying its own name and its own fields, so an app branches on the refusal
	 * rather than reading its sentence. What the new generation then meets while it
	 * FOLDS (a node on another chain, a refused write) reaches the tab where every
	 * other driver failure does, on `progress`.
	 */
	reconfigure(update: {readonly source: IndexingSource<Abi>}): Promise<HostReconfigure>;
	/**
	 * EVERY GENERATION THE HOST HOLDS, with the one answering reads marked and each
	 * one's progress.
	 *
	 * Asked rather than pushed, because a generation list moves when somebody
	 * RECONFIGURES or a pointer moves and not while a fold advances -- which is also
	 * why a tab that has just reconfigured is the one that asks.
	 */
	generations(): Promise<readonly HostGeneration[]>;
	/**
	 * THE PROMOTION POLICY IN FORCE, as the host's container resolved it.
	 *
	 * Nothing is defaulted on this side. There is one default everywhere
	 * (`on-catch-up`) and it lives with the type it belongs to, so a value invented
	 * here would be a second answer to "which policy is this app running under"
	 * (`CONTEXT.md`, *canonical pointer*).
	 */
	promotion(): Promise<UsedPromotionConfig>;
	/**
	 * DOES THE STATE THIS APP IS ABOUT TO RENDER ALREADY ACCOUNT FOR THESE
	 * TRANSACTIONS?
	 *
	 * The reconciliation an app needs before it lays an OPTIMISTIC update over
	 * indexed state: applied on top of a state that already contains it, a
	 * non-idempotent update (a counter, a balance, an append) is counted twice.
	 * See `checkTxInclusion` in `@etherfold/core` for what the verdicts mean, why
	 * the caller's own receipt cannot answer this, and what it cannot tell you.
	 *
	 * ```ts
	 * const verdicts = await indexer.checkTxInclusion(pending.map(({hash, block}) => ({txHash: hash, minedAtBlock: block})));
	 * for (const {hash} of pending) {
	 *   if (verdicts[hash].status === 'included') overlay.drop(hash); // the fold has it: stop predicting it
	 * }
	 * ```
	 *
	 * THE WHOLE PENDING SET IN ONE CALL, because that is how an app holding one
	 * uses it: one round trip, and one verdict per hash keyed as it was asked for.
	 *
	 * The verdict crosses WHOLE -- a STATUS and the BASIS for it -- and reading the
	 * status alone is the mistake to avoid. `unknown` has two causes (nothing is
	 * synced yet; the fold is so far behind the tip that its window says nothing
	 * about the region asked about), and both mean KEEP the optimistic update,
	 * where an honest `absent` means the fold has looked and not found it.
	 * `minedAtBlock` is per query and is what a caller holding a RECEIPT passes to
	 * close the sparse window's two limits, through the `below-window` branch.
	 *
	 * A SNAPSHOT and not a subscription: it is answered from where the fold is at
	 * the moment of the call, so an app watching a transaction ASKS AGAIN -- when
	 * `onProgress` says the fold moved, which is exactly when the answer can have
	 * changed.
	 */
	checkTxInclusion(queries: readonly TxInclusionQuery[]): Promise<Record<string, TxInclusionVerdict>>;
	/**
	 * THE STORE'S FOUR READS, served by the host from the store its canonical
	 * generation folds into.
	 *
	 * Untyped here, by entity NAME, exactly as `EntityStateView` is on this thread:
	 * what an app should hold is the TYPED surface generated from its own
	 * declarations over these, which is `createPortReadSurface(port, entities)`.
	 *
	 * There is nothing beside them that could mutate, and that is a fact of this
	 * type rather than a rule to remember: the host opened the store for WRITING
	 * and what crosses is four reads (ADR-0077, ADR-0082).
	 */
	readonly reads: PortStateReads;
	/**
	 * Stop holding the host.
	 *
	 * Every call still in flight REJECTS: a hung promise is the worst available
	 * outcome, because a stalled app and a slow app look identical from outside
	 * (ADR-0082). What `close` does to the host itself is the hosting shape's
	 * business -- a dedicated worker belongs to the tab that made it and is
	 * terminated; a SharedWorker serving other tabs is not.
	 */
	close(): void;
};

/**
 * HOLD A HOST that is not this thread.
 *
 * ```ts
 * const indexer = connectToIndexerHost(
 *   dedicatedWorkerHost(new Worker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module'})),
 * );
 * const {lastToBlock, latestBlock} = await indexer.progress();
 * ```
 *
 * It knows nothing about workers. The first argument is the ONE thing a hosting
 * shape differs in, which is why choosing a shape is a different call rather than
 * a flag threaded through this one.
 *
 * ## It also owns the host's LIFETIME
 *
 * A host can stop existing -- browsers evict workers -- and the four things that
 * then happen are this function's (ADR-0082): the app is TOLD (`onHostDeath`),
 * every call in flight REJECTS with an `IndexerHostDiedError`, another host is
 * STARTED through the shape's own `reopen`, and the fold RESUMES from the cursor
 * without anything here telling it where to start (ADR-0027). The second argument
 * is what a tab may say about that; the defaults are in `resolvePortOptions` and
 * are meant to be left alone.
 */
export function connectToIndexerHost(access: HostAccess, options?: IndexerPortOptions): IndexerPort {
	const lifetime = resolvePortOptions(options);
	/** What was asked, and WHICH CASE it was asked on, so a refusal can name it. */
	type Pending = {resolve: (value: never) => void; reject: (error: unknown) => void; case: PortCaseName};
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let closed = false;

	/**
	 * THE ACCESS CURRENTLY HELD, which is not the one this port was built with once
	 * a host has died: a restart REPLACES it with what the shape's `reopen`
	 * answered.
	 */
	let held = access;
	/** Whether the corpse has already been let go, so `close` does not release it twice. */
	let released = false;
	/** NOTHING IS ANSWERING: the host died, and a restart is either pending or not coming. */
	let dead = false;
	/** The last death, which is what a call made while `dead` is rejected with. */
	let lastDeath: HostDeath | undefined;
	/** How many deaths IN A ROW. Forgotten once a host has been alive long enough to have settled. */
	let deaths = 0;
	/** When this port last heard anything OF ITS OWN from the host. The whole of what a watch reads. */
	let heardAt = Date.now();
	let probing = false;
	let watchTimer: ReturnType<typeof setTimeout> | undefined;
	let restartTimer: ReturnType<typeof setTimeout> | undefined;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * A timer that must not hold a runtime open on its own.
	 *
	 * `unref` is node's and is absent in a browser, which is the runtime this is
	 * actually for -- but a port is built in node tests too, and a liveness watch that
	 * kept the process alive would turn a finished test into a hang.
	 */
	function unattended(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
		(timer as unknown as {unref?: () => void}).unref?.();
		return timer;
	}

	/**
	 * WHO IS LISTENING, and the LAST THING THE HOST SAID.
	 *
	 * The value is held for one reason: a listener added while a subscription is
	 * already open has missed the answer that opened it, and would otherwise render
	 * nothing until the fold next moved (which, at the tip, is never). It is the
	 * host's own last word verbatim and is replaced wholesale, never merged into --
	 * a tab that MAINTAINED a progress object would be the duplicated state ADR-0082
	 * refuses.
	 */
	const listeners = new Set<(progress: HostProgress) => void>();
	let latest: HostProgress | undefined;

	function announce(progress: HostProgress): void {
		latest = progress;
		for (const listener of listeners) listener(progress);
	}

	const deathListeners = new Set<(death: HostDeath) => void>();

	function receive(data: unknown): void {
		if (isPortPush(data)) {
			// HEARD, and only from a message that is OURS: a shared scope carries whatever
			// anybody posts to it, and somebody else's traffic is not evidence that this
			// host is alive.
			heardAt = Date.now();
			// Narrowed by NAME, which is what makes a second push a `case` here rather
			// than a cast.
			if (data.push === 'progress') announce(data.value);
			return;
		}
		if (!isPortResponse(data)) return;
		heardAt = Date.now();
		const waiting = pending.get(data.id);
		// An answer to a call nobody is waiting for: a response that arrived after
		// its caller gave up. Dropped rather than raised -- there is no caller to
		// raise it to.
		if (!waiting) return;
		pending.delete(data.id);
		if (data.ok) {
			(waiting.resolve as (value: unknown) => void)(data.value);
		} else {
			waiting.reject(errorFromPort(data.error));
		}
	}

	let stopListening = listen(held.endpoint, receive);

	/**
	 * WATCH THE HOST, which is the only way a tab can learn it died.
	 *
	 * No browser fires an event when it evicts a dedicated worker, and
	 * `Worker.terminate()` is silent by construction, so what is left is silence and
	 * a question. The rule is one line: if the host has said NOTHING for an interval,
	 * PROBE it, and if the probe is not answered within another, it is gone. A host
	 * that is folding, answering or pushing is visibly alive and is never asked.
	 *
	 * What is watched is LIVENESS and never STATUS. Asking for `progress` on a timer
	 * would answer this question too and would be exactly the polling ADR-0082
	 * replaced with a push, with the cost moved to the other end of the wire.
	 */
	function watch(): void {
		if (!lifetime.watch || closed || dead) return;
		const everyMs = lifetime.watch.everyInSeconds * 1000;
		watchTimer = unattended(
			setTimeout(() => {
				watchTimer = undefined;
				if (closed || dead) return;
				if (Date.now() - heardAt < everyMs) {
					watch();
					return;
				}
				void probe(everyMs).then(watch);
			}, everyMs),
		);
	}

	/** Ask the one question whose ANSWER is its whole content, and conclude a death if none comes. */
	async function probe(withinMs: number): Promise<void> {
		if (probing || closed || dead) return;
		probing = true;
		let waited: ReturnType<typeof setTimeout> | undefined;
		const answered = request('ping', undefined).then(
			() => true,
			() => false,
		);
		const alive = await Promise.race([
			answered,
			new Promise<boolean>((resolve) => {
				waited = unattended(setTimeout(() => resolve(false), withinMs));
			}),
		]);
		clearTimeout(waited);
		probing = false;
		if (!alive && !closed && !dead) died();
	}

	/**
	 * THE HOST IS GONE. Kill the corpse, reject the calls, tell the app, start
	 * another one -- IN THAT ORDER.
	 *
	 * The order is the safety property. What is released first is the access to the
	 * host that is not answering, so a host merely SUSPECTED of being dead is
	 * terminated rather than left running beside its successor: at no point are two
	 * hosts writing to one store. The writer claim is underneath that as a second
	 * guarantee rather than the mechanism -- it neither blocks nor expires, so a
	 * writer killed mid-block leaves a store the next claim takes over, and a corpse
	 * that somehow lived is REFUSED at its next mutation (ADR-0075).
	 */
	function died(): void {
		const attempt = ++deaths;
		const restarting = Boolean(held.reopen) && attempt <= lifetime.restart.attempts;
		const restartInSeconds = restarting ? backoffFor(attempt, lifetime.restart) : undefined;
		dead = true;
		clearTimeout(watchTimer);
		clearTimeout(settleTimer);
		watchTimer = undefined;
		settleTimer = undefined;

		const corpse = held;
		stopListening();
		released = true;
		try {
			corpse.close?.();
		} catch (error) {
			// Letting go of something that has already gone is not a failure worth raising
			// at an app, and the restart below must happen either way.
			namedLogger.error(`the indexer port could not release the host it is replacing`, error);
		}

		const death: HostDeath = {
			cause: 'unresponsive',
			attempt,
			restarting,
			...(restartInSeconds === undefined ? {} : {restartInSeconds}),
			// The APP's calls. A probe is this port's own bookkeeping, and counting it
			// would report a rejection to an app that never made a call.
			rejected: [...pending.values()].filter((waiting) => waiting.case !== 'ping').length,
		};
		lastDeath = death;
		// The last report described a host that no longer exists, so it is DROPPED
		// rather than handed to the next listener that attaches -- the same choice the
		// host makes when a promotion retires the generation its cursor belonged to.
		latest = undefined;
		for (const [id, waiting] of pending) {
			pending.delete(id);
			waiting.reject(new IndexerHostDiedError(death, waiting.case));
		}
		for (const listener of [...deathListeners]) listener(death);

		if (restarting) {
			restartTimer = unattended(setTimeout(() => restart(corpse), (restartInSeconds ?? 0) * 1000));
		} else {
			namedLogger.error(
				`the indexer host died ${attempt} time(s) in a row and is not being restarted; this port holds nothing.`,
			);
		}
	}

	/**
	 * OBTAIN A PORT AGAIN, to a host that is new and knows nothing.
	 *
	 * There is nothing to hand it: where the fold got to is in the store, written in
	 * the same transaction as the block it describes (ADR-0027), so a host that
	 * starts reads the cursor and carries on. A port that told one where to resume
	 * from would be a second opinion about a question only the store can answer.
	 *
	 * What IS restored is this tab's own subscription, because that belongs to the
	 * tab rather than to the host that happened to be serving it: an app that had to
	 * re-attach after every restart would be holding exactly the lifecycle this is
	 * hiding.
	 */
	function restart(previous: HostAccess): void {
		restartTimer = undefined;
		if (closed) return;
		try {
			held = previous.reopen!();
		} catch (error) {
			namedLogger.error(`the indexer port could not start another host, so this one holds nothing`, error);
			const abandoned: HostDeath = {cause: 'unresponsive', attempt: deaths, restarting: false, rejected: 0};
			lastDeath = abandoned;
			for (const listener of [...deathListeners]) listener(abandoned);
			return;
		}
		stopListening = listen(held.endpoint, receive);
		released = false;
		dead = false;
		heardAt = Date.now();
		// ALIVE LONG ENOUGH IS FORGIVEN: the budget bounds a crash LOOP, not the number
		// of evictions a tab open all day may survive.
		settleTimer = unattended(
			setTimeout(() => {
				deaths = 0;
			}, lifetime.restart.settledAfterInSeconds * 1000),
		);
		watch();
		if (listeners.size > 0) {
			// The answer IS the new host's current progress, so a subscriber is told where
			// things stand now rather than waiting for the resumed fold to move.
			request('subscribeToProgress', undefined).then(announce, () => undefined);
		}
	}

	function request<Case extends PortCaseName>(
		name: Case,
		payload: PortRequestPayload<Case>,
	): Promise<PortResponseValue<Case>> {
		if (closed) {
			return Promise.reject(
				new Error(`this indexer port is closed, so the '${name}' call was not sent. Connect to the host again.`),
			);
		}
		if (dead && lastDeath) {
			// REFUSED NOW, and by the same type the calls in flight got. A call made while
			// a restart is under way has no host to reach, and holding it until one exists
			// would be the silent retry ADR-0082 refuses: a caller that wants to ask again
			// is told it can, and is not left waiting to find out.
			return Promise.reject(new IndexerHostDiedError(lastDeath, name));
		}
		const id = nextId++;
		const message: PortRequest<Case> = {
			protocol: INDEXER_PORT_PROTOCOL,
			kind: 'request',
			id,
			case: name,
			payload,
		};
		return new Promise<PortResponseValue<Case>>((resolve, reject) => {
			// REFUSED HERE, naming the field, rather than thrown out of `postMessage`
			// naming an object. Inside the promise, so the caller's own call REJECTS: a
			// method that answers a promise everywhere else must not throw past an
			// `await ... .catch(...)` on the one input it refuses.
			assertClonable(payload, `the '${name}' request`);
			pending.set(id, {resolve: resolve as (value: never) => void, reject, case: name});
			try {
				held.endpoint.postMessage(message);
			} catch (error) {
				pending.delete(id);
				reject(error);
			}
		});
	}

	watch();

	return {
		host: access.host,
		progress: () => request('progress', undefined),
		onHostDeath(listener) {
			deathListeners.add(listener);
			return () => {
				deathListeners.delete(listener);
			};
		},
		onProgress(listener) {
			const first = listeners.size === 0;
			listeners.add(listener);
			if (first) {
				// The answer IS the current progress, so there is no window in which a
				// freshly attached tab holds nothing and no race with a first push.
				request('subscribeToProgress', undefined).then(announce, () => {
					// A port closed before the host answered. The caller's own `close` is
					// what rejected it, and there is no call here to report it to.
				});
			} else if (latest) {
				// Already subscribed, so this listener missed the answer that opened it.
				// Asynchronously, so a listener never fires before the call that added it
				// returned its detach.
				const known = latest;
				queueMicrotask(() => {
					if (listeners.has(listener)) listener(known);
				});
			}
			return () => {
				if (!listeners.delete(listener)) return;
				if (listeners.size > 0 || closed) return;
				latest = undefined;
				// The HOST stops posting, rather than this end stopping listening: a tab
				// that went on receiving what it unsubscribed from would still be paying
				// for it. Nothing awaits this -- there is no answer worth having.
				void request('unsubscribeFromProgress', undefined).catch(() => undefined);
			};
		},
		startIndexing: () => request('startIndexing', undefined),
		stopIndexing: () => request('stopIndexing', undefined),
		reconfigure: (update) => request('reconfigure', {source: update.source}),
		generations: () => request('generations', undefined),
		promotion: () => request('promotion', undefined),
		checkTxInclusion: (queries) => request('checkTxInclusion', {queries}),
		reads: {
			declarations: () => request('declarations', undefined),
			getCurrent: (entity, id) => request('getCurrent', {entity, id}),
			getAsOf: (entity, id, at) => request('getAsOf', {entity, id, at}),
			listCurrent: (entity, prefix, limit) => request('listCurrent', {entity, prefix, limit}),
			listAsOf: (entity, prefix, at, limit) => request('listAsOf', {entity, prefix, at, limit}),
		},
		close() {
			if (closed) return;
			closed = true;
			listeners.clear();
			deathListeners.clear();
			latest = undefined;
			// A CLOSE IS NOT A DEATH: the tab asked for this one, so there is nobody to
			// tell and nothing to restart -- a port that started a host here would build
			// one for an app that has gone.
			clearTimeout(watchTimer);
			clearTimeout(restartTimer);
			clearTimeout(settleTimer);
			stopListening();
			const closing = new Error(`the indexer port was closed while this call was in flight.`);
			for (const [id, waiting] of pending) {
				pending.delete(id);
				waiting.reject(closing);
			}
			if (!released) held.close?.();
		},
	};
}
