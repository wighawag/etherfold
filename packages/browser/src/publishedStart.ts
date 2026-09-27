import type {
	Abi,
	ExistingStream,
	Indexer,
	IndexingSource,
	LastSync,
	NotInstalledReason,
	ProvidedIndexerConfig,
	StreamSeedInstallOutcome,
	StreamSeedLocation,
} from '@etherfold/core';
import {installStreamSeed, resolveStreamConfig, streamDigestOf} from '@etherfold/core';
import {logs} from 'named-logs';
import {
	DEFAULT_CATCH_UP_WITHIN_SECONDS,
	publishedSeedLocationsFor,
	publishedSnapshotFor,
	readPublicationIndex,
	type BrowserPublicationOptions,
	type PublicationSnapshot,
	type PublicationState,
	type ReadPublication,
	type SnapshotSwitchReason,
} from './publication.js';

const namedLogger = logs('@etherfold/browser');

// ---------------------------------------------------------------------------------------------------
// A HOST STARTS FROM WHAT A BUILD PUBLISHED, in every hosting shape (ADR-0082, ADR-0095, ADR-0096)
// ---------------------------------------------------------------------------------------------------
// The three things a tab can start from, and the one decision a returning tab takes mid-run:
//
// - the PUBLICATION INDEX (`publication`): read before the generation is built, and the state snapshot
//   entry for that generation handed to the app's `createState`;
// - the STREAM SEED (`seed`, or the one the index lists when `publication.seed` asks for it): installed
//   into `keepStream` before the generation loads;
// - the RETURNING-TAB SWITCH (`catchUpWithinSeconds`): a catch-up the node refuses as an archive
//   refusal, or one estimated to take longer than the budget, is abandoned for the published snapshot.
//
// ONE implementation, reached by every host. The main-thread host (`createIndexerState`) and the
// worker hosts' driver (`host/serve.ts`) differ in how they hold a container and how they report, so
// each hands this module the two things only it can do -- let go of its container and open it again,
// and publish an outcome where its app reads it -- and everything else is here: which entry, when a seed
// is fetched, what the estimate is, when a switch applies and whether it took. ADR-0082: "three hosts
// running three implementations is the obvious accident".
// ---------------------------------------------------------------------------------------------------

/**
 * WHICH WAY a refused seed and this client disagree, where the reason carries a
 * direction at all (ADR-0064).
 *
 * It is the refusal REASON, narrowed: the two members are exactly the two
 * reasons that name a direction, restated here so an application can switch on
 * one field instead of knowing which members of the refusal vocabulary happen to
 * be directional. It is DERIVED from `reason` and is never a second fact.
 *
 * What nothing in this library does with it is INFER. An app may render "a newer
 * version of this app may be available" off `seed-covers-more`; the library may
 * not, because a deliberately NARROWER client is indistinguishable from a stale
 * one and only the application knows which it is (ADR-0064).
 */
export type StreamSeedDirection = Extract<NotInstalledReason, 'seed-covers-more' | 'seed-covers-less'>;

/**
 * WHAT HAPPENED TO THE STREAM SEED, as a small discriminated state an app can
 * render: `SyncingState.streamSeed` on the main thread, `HostProgress.streamSeed`
 * across a port.
 *
 * The visibility half of `a-browser-app-starts-from-a-published-artifact`: an
 * app that cannot say WHY it has no seed shows an empty screen instead of an
 * explanation, which is the outcome that spec exists to avoid (ADR-0064). So the
 * outcome the loader returns reaches the surface an application already
 * subscribes to, and not only the boot path's return value.
 *
 * It REPORTS and it does not decide, exactly as `nonCanonicalGenerations` does:
 * whether "installing", "seeded" or "refused" should dim, hide or replace what is
 * on screen is the application's call.
 *
 * ## What it deliberately does NOT carry
 *
 * **No byte-level progress.** In the recommended single-document shape the whole
 * install is about 1 s on a mid-range phone and ~300 ms on desktop, which a
 * spinner covers; the variable part is the DOWNLOAD, not the install, so a
 * progress signal belongs on the fetch as an optional loader callback if it is
 * ever wanted (`work/notes/findings/what-a-published-stream-seed-costs-to-install.md`).
 * `installing` and the terminal states are the whole surface, which is also why
 * this field publishes at most twice per boot.
 *
 * **No inference.** See `StreamSeedDirection`.
 */
export type StreamSeedState =
	/**
	 * The install is running. Published before the fetch, and replaced by a
	 * terminal state on every path the loader RETURNS from -- which is every
	 * ordinary one, since a refusal is data.
	 *
	 * The exception, stated here because this is what an app author reads: if the
	 * loader THROWS (a malformed `expectedContentHash`, a keeper failing mid-install,
	 * a batch declined by another writer) there is no outcome to report, so this
	 * value STANDS and the boot fails instead (`init` rejects on the main thread; a
	 * worker host reports `phase: 'refused'` with the failure). Neither of the
	 * alternatives is truthful -- clearing the field says no seed was asked for, and
	 * a synthetic terminal state needs a reason the loader's vocabulary does not
	 * have -- so the honest signal is the failure, and an app must treat it as the
	 * end of the boot rather than waiting on this field. The main thread's status
	 * phase does NOT stick: it returns to `Idle`, so a spinner keyed on
	 * `InstallingStreamSeed` (which is what the guide shows) clears.
	 */
	| {readonly status: 'installing'}
	| {
			/** A stream was installed, and the app now holds history it never fetched. */
			readonly status: 'seeded';
			/** How far the installed stream REACHES: the seed's coverage end, above its last event. */
			readonly at: number;
			/** How far back it reaches: what the keeper recorded as the stream's `startBlock`. */
			readonly reachesBackTo: number;
			/** WHICH location served it, so an app can say where its history came from. */
			readonly from: string;
			readonly events: number;
			/** How many saves it took, which is how many SEGMENTS the keeper now holds. */
			readonly segments: number;
	  }
	| {
			/**
			 * No seed was installed, and the app STARTS ANYWAY.
			 *
			 * A refusal is a NORMAL condition and never gates the boot (ADR-0064): state
			 * still comes up from a published snapshot and indexes forward from the tip,
			 * and what is lost is the stream underneath, so the generation is a leaf and a
			 * later processor-only change waits for a republished snapshot instead of
			 * being free. That is why this is its own field and not `error`: an app
			 * treating `error` as a fault would render a crash for an ordinary outcome,
			 * and `acknowledgeError()` does not fit an outcome nothing can acknowledge
			 * away.
			 */
			readonly status: 'refused';
			/** WHY, verbatim from the loader, so an app can explain it. */
			readonly reason: NotInstalledReason;
			/** Present only where the reason names one. See `StreamSeedDirection`. */
			readonly direction?: StreamSeedDirection;
	  };

/**
 * WHERE A PUBLISHED STREAM SEED COMES FROM, as a host takes it: the `seed` option
 * of `createIndexerState`, and the `seed` field of a worker host's spec.
 *
 * ## Convenience, not a trust boundary and not a safety mechanism
 *
 * The loader is callable directly (`installStreamSeed`, `@etherfold/core`) and
 * an application may drive the install itself; this option saves it sequencing
 * the call, and gives the host's surface something to publish. It is NOT a
 * safety mechanism: the install carries its own RESOLVED stream config and sets
 * it on the keeper before it addresses anything (ADR-0067), so it is correct
 * whether it runs before or after a generation exists.
 *
 * ## The trust contract travels with the locations (ADR-0066)
 *
 * The CALLER names the locations and owns that choice: the loader fetches where
 * it is pointed and nowhere else, so there is no origin check to make. Keep BOTH
 * the list and any `expectedContentHash` in the BUILD -- a pin read from the same
 * place as the artifact proves nothing -- and read `installStreamSeed`'s own
 * JSDoc before shipping one, including what it does NOT defend against
 * (OMISSION, which is impossible within the premise rather than deferred).
 */
export type BrowserStreamSeedOptions = {
	/**
	 * The ORDERED list, freshest first, walked until one is usable. A relative,
	 * hostless path is a first-class location and is what a BUILD-EMBEDDED artifact
	 * is listed as, ordinarily LAST so the app still starts when the remote is gone.
	 */
	locations: StreamSeedLocation | readonly StreamSeedLocation[];
	/**
	 * An OPTIONAL content hash, verbatim as the producer printed it
	 * (`sha256:<hex>`). Only an IMMUTABLE, release-tied artifact can have one
	 * pinned: a build cannot know the hash of a ROLLING artifact, and rolling is how
	 * this is ordinarily deployed.
	 */
	expectedContentHash?: string;
	/**
	 * The block the client will ask this stream FROM, which a seed must reach back
	 * to or be refused. Defaults to the source's own earliest `startBlock`, which is
	 * exactly what a fresh generation's `load()` asks for.
	 */
	reachBackTo?: number;
	/** How many events one save carries, at most. Defaults to the loader's own 1,000. */
	maxEventsPerBatch?: number;
	/** Injectable for tests and for a host with its own retry/timeout policy. */
	fetch?: typeof globalThis.fetch;
};

/**
 * WHAT A HOST MAY START FROM: the options every hosting shape takes under the same
 * names, `createIndexerState`'s and a worker host's spec's alike.
 */
export type PublishedStartOptions<ABI extends Abi> = {
	/**
	 * The stream keeper a `seed` is installed into. A seed IS a stream, so asking for
	 * one with no keeper is refused as a wiring mistake rather than reported as data.
	 */
	keepStream?: ExistingStream<ABI>;
	/**
	 * INSTALL A PUBLISHED STREAM SEED into `keepStream` before the generation loads.
	 * See `BrowserStreamSeedOptions` for the trust contract, which is the caller's.
	 */
	seed?: BrowserStreamSeedOptions;
	/**
	 * START FROM A PUBLICATION INDEX (`publication.json`, ADR-0095). The snapshot
	 * entry for the generation the host builds is handed to `createState`; the seed
	 * the index lists is installed only when `seed` asks for it.
	 */
	publication?: BrowserPublicationOptions;
	/**
	 * HOW LONG A RETURNING TAB MAY SPEND CATCHING UP before it starts from the
	 * published snapshot instead, in seconds, or `'always'` (ADR-0096). Defaults to
	 * `DEFAULT_CATCH_UP_WITHIN_SECONDS` (thirty).
	 */
	catchUpWithinSeconds?: number | 'always';
};

/**
 * WHERE A HOST PUBLISHES WHAT THIS MODULE DID: the one thing that differs between
 * the main thread (reactive stores) and a worker (the port's progress).
 */
export type PublishedStartReport = {
	/** The lookup, and later a switch. */
	publication(state: PublicationState): void;
	/** The seed install: `installing`, then its terminal outcome. */
	streamSeed(state: StreamSeedState): void;
	/**
	 * The seed install began (`true`) or ended (`false`), thrown or not. The main
	 * thread moves its status phase on it (`InstallingStreamSeed`, then `Idle`); a
	 * port has no finer phase to move, since `streamSeed` already says it.
	 */
	installingSeed?(installing: boolean): void;
};

/** Why a catch-up was abandoned, with the estimate and budget where it was over one. */
export type SnapshotSwitchWhy = {
	reason: SnapshotSwitchReason;
	estimateSeconds?: number;
	budgetSeconds?: number;
};

/**
 * WHAT A HOST DOES TO SWITCH, and nothing else: it holds the container, so it lets
 * go of it and opens it again. The decision, the log and the report are this
 * module's.
 */
export type SnapshotSwitchHost<ABI extends Abi> = {
	/** The container folding the local state, or `undefined` where there is none. */
	readonly container: Indexer<ABI, any> | undefined;
	/** A tab that stopped being a writer switches nothing: it folds nothing. */
	readonly demoted: boolean;
	/** Stop the container folding the local state and detach everything this host hung on it. */
	letGo(container: Indexer<ABI, any>): void;
	/**
	 * Open the container again over the generation the boot built, with `createState`
	 * handed the snapshot and `replaceLocal: true`, LOAD it, and answer the cursor it
	 * loaded.
	 */
	reopen(): Promise<LastSync<ABI>>;
};

/**
 * THE CATCH-UP BUDGET, as configured, or refused where it cannot mean a budget.
 *
 * Refused rather than read as something else: a negative or non-finite number of
 * seconds is a computation gone wrong in the app, and reading it as `'always'` or
 * as zero would silently pick one of the two opposite behaviours.
 */
export function catchUpBudgetOf(value: number | 'always' | undefined): number | 'always' {
	if (value === undefined) return DEFAULT_CATCH_UP_WITHIN_SECONDS;
	if (value === 'always') return value;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error(
			`catchUpWithinSeconds must be a number of seconds (zero or more) or 'always', and it is ${String(value)}.`,
		);
	}
	return value;
}

/**
 * Whether a failed advance is the node refusing history as needing ARCHIVE access
 * (`ArchiveRefusedError`, `@etherfold/core`).
 *
 * Read STRUCTURALLY, by the error's own name, as `isRetryable` reads its flag: a
 * second copy of `@etherfold/core` in a bundle would fail an `instanceof` and turn
 * the one refusal a snapshot can get past into a stopped tab.
 */
function isArchiveRefusal(error: unknown): boolean {
	return (error as {name?: unknown} | undefined)?.name === 'ArchiveRefusedError';
}

/** The two refusal reasons that name a direction, and no others. */
function directionOf(reason: NotInstalledReason): StreamSeedDirection | undefined {
	return reason === 'seed-covers-more' || reason === 'seed-covers-less' ? reason : undefined;
}

/**
 * The loader's outcome as a host publishes it, plus the direction where the
 * reason carries one. A translation and not a re-decision.
 */
function streamSeedStateOf(outcome: StreamSeedInstallOutcome): StreamSeedState {
	if (outcome.status === 'installed') {
		return {
			status: 'seeded',
			at: outcome.at,
			reachesBackTo: outcome.reachesBackTo,
			from: outcome.from,
			events: outcome.events,
			segments: outcome.segments,
		};
	}
	const direction = directionOf(outcome.reason);
	return {status: 'refused', reason: outcome.reason, ...(direction ? {direction} : {})};
}

/** What a host holds for the start: built once per host, and `reset` wherever the host starts over. */
export type PublishedStart<ABI extends Abi> = ReturnType<typeof createPublishedStart<ABI>>;

/**
 * THE PUBLISHED START OF ONE HOST, and its returning-tab switch.
 *
 * Built where the host is built. The budget is validated HERE, so a main-thread
 * host refuses it at construction as it always did, and a worker host, which
 * builds this inside its first open, reports it as its failure.
 */
export function createPublishedStart<ABI extends Abi>(
	options: PublishedStartOptions<ABI>,
	report: PublishedStartReport,
) {
	const budget = catchUpBudgetOf(options.catchUpWithinSeconds);
	/** The index the boot read, for the ONE generation the boot builds. */
	let read: ReadPublication | undefined;
	/** The snapshot the publication named for that generation, if it named one. */
	let bootSnapshot: PublicationSnapshot | undefined;
	/**
	 * WHAT THE CATCH-UP HAS MEASURED so far: the blocks the canonical generation's
	 * advances covered and the time they took, over the container now open.
	 */
	let measured = {blocks: 0, ms: 0};
	/** Whether the switch was tried. One try per boot: see `switchTo`. */
	let tried = false;

	/**
	 * INSTALL THE PUBLISHED SEED, and PUBLISH what it did.
	 *
	 * BEFORE the generation is built, so the fold that follows finds the stream
	 * already there rather than fetching a history a public node would refuse to
	 * serve. Ordering is not what makes it correct, though: the install takes the
	 * RESOLVED stream config as an argument and sets it on the keeper itself
	 * (ADR-0067).
	 *
	 * TWO publications and never more: `installing`, then the terminal outcome. A
	 * refusal is DATA and does not stop anything (ADR-0064). What DOES propagate is
	 * a THROW, which the loader reserves for what is not an ordinary condition, and
	 * `installing` is then left standing, which is what actually happened.
	 */
	async function installSeed(
		seed: BrowserStreamSeedOptions,
		source: IndexingSource<ABI>,
		config: ProvidedIndexerConfig<ABI>,
	): Promise<void> {
		const keepStream = config.keepStream;
		if (!keepStream) {
			throw new Error(
				`a stream seed was given with no \`keepStream\`: a seed IS a stream, so there is nothing to install it ` +
					`into. Pass a keeper (\`keepStreamOnIndexedDB(name)\`), or drop the seed and run the snapshot-only mode.`,
			);
		}
		report.streamSeed({status: 'installing'});
		report.installingSeed?.(true);
		try {
			const outcome = await installStreamSeed(keepStream, seed.locations, {
				source,
				// RESOLVED here, because the install addresses the subtree with it and the
				// digest half of that address must be the one the indexer itself will run
				// under -- never the config as a user spelled it.
				streamConfig: resolveStreamConfig(config.stream),
				...(seed.reachBackTo === undefined ? {} : {reachBackTo: seed.reachBackTo}),
				...(seed.maxEventsPerBatch === undefined ? {} : {maxEventsPerBatch: seed.maxEventsPerBatch}),
				...(seed.expectedContentHash === undefined ? {} : {expectedContentHash: seed.expectedContentHash}),
				...(seed.fetch === undefined ? {} : {fetch: seed.fetch}),
			});
			report.streamSeed(streamSeedStateOf(outcome));
			// The install is over either way, and nothing is loading yet: leaving an
			// installing phase standing would be the one thing that is certainly untrue.
			report.installingSeed?.(false);
		} catch (err) {
			report.installingSeed?.(false);
			throw err;
		}
	}

	/**
	 * ABANDON THE CATCH-UP FOR THE SNAPSHOT: build the generation again, with
	 * `createState` handed `replaceLocal: true`, and resume from what it installed
	 * (ADR-0096).
	 *
	 * The install is NOT here and there is not a second one: the snapshot is
	 * installed by the app's `createState` through `openAndBootstrap`, which wipes
	 * the local state first, exactly as it installs on a fresh tab. What the HOST
	 * does is what only it can: let go of the container folding the local state and
	 * open it again, so the factory runs again and the fold that follows reads the
	 * snapshot's cursor.
	 *
	 * `undefined` means NOTHING WAS SWITCHED, and the caller carries on as before (a
	 * refusal is re-thrown, an over-budget catch-up goes on catching up). That is the
	 * answer when the switch cannot help (no snapshot for this generation, local state
	 * already at or ahead of it, a demoted tab), when the container holds more than the
	 * one generation the boot built (rebuilding it would drop a successor), when it was
	 * already tried, and when the factory did not install: a `createState` that does
	 * not forward `replaceLocal`, or a body no longer reachable. Tried ONCE per boot,
	 * so an install that fails is not re-attempted every cycle.
	 */
	async function switchTo(why: SnapshotSwitchWhy, host: SnapshotSwitchHost<ABI>): Promise<LastSync<ABI> | undefined> {
		const snapshot = bootSnapshot;
		const open = host.container;
		if (!snapshot || !open || tried || host.demoted || open.generations.length !== 1) {
			return undefined;
		}
		const left = open.canonical.lastSync?.lastToBlock;
		const at = snapshot.entry.takenAt.number;
		if (left === undefined || left >= at) {
			return undefined;
		}
		tried = true;
		namedLogger.warn(
			why.reason === 'archive-refused'
				? `the node refused this tab's catch-up from block ${left} as needing ARCHIVE access, so it starts from ` +
						`the published snapshot at block ${at} instead`
				: `this tab's catch-up from block ${left} was estimated at ${Math.round(why.estimateSeconds ?? 0)} s, ` +
						`over its budget of ${why.budgetSeconds} s, so it starts from the published snapshot at block ${at} instead`,
		);
		// LET GO of the container folding the local state: nothing it does from here is
		// kept, and its callbacks close over the host's own surfaces.
		host.letGo(open);
		const loaded = await host.reopen();
		if (loaded.lastToBlock <= left) {
			namedLogger.warn(
				`the published snapshot at block ${at} was NOT installed (did \`createState\` forward ` +
					`\`published.replaceLocal\` to \`openAndBootstrap\`, and is the body still reachable?), so this tab ` +
					`goes on from its own state at block ${loaded.lastToBlock}`,
			);
			return undefined;
		}
		report.publication({
			status: 'switched',
			reason: why.reason,
			from: snapshot.index,
			snapshot: snapshot.locations[0],
			at,
			left,
			...(why.estimateSeconds === undefined ? {} : {estimateSeconds: why.estimateSeconds}),
			...(why.budgetSeconds === undefined ? {} : {budgetSeconds: why.budgetSeconds}),
		});
		return loaded;
	}

	return {
		/**
		 * READ THE INDEX AND INSTALL THE SEED, before the generation is built.
		 *
		 * The index is read first: the seed it lists (when asked for) is installed
		 * here, and the snapshot entry is chosen when the generation's state is built,
		 * by the identity it is registered under (`snapshotFor`). A `seed` given beside
		 * a publication asking for its seed is refused: a boot installs ONE seed.
		 */
		async prepare(boot: {source: IndexingSource<ABI>; config: ProvidedIndexerConfig<ABI>}): Promise<void> {
			const publication = options.publication;
			let seed = options.seed;
			read = undefined;
			if (publication) {
				if (publication.seed && seed) {
					throw new Error(
						`both a \`seed\` and a \`publication\` asking for its seed were given: a boot installs ONE stream seed, ` +
							`from one place. Drop \`seed\` to take the one the publication lists, or drop \`publication.seed\`.`,
					);
				}
				report.publication({status: 'reading'});
				read = await readPublicationIndex(publication.locations, publication.fetch);
				if (read.status !== 'read') {
					// Terminal already: no index means no entry for any generation.
					report.publication({status: 'refused', reason: read.status});
				}
				if (publication.seed) {
					// ONLY when asked (ADR-0095). The locations are the index's entry for THIS
					// stream, or none, which the install itself reports as `no-locations`.
					const stream = streamDigestOf(boot.source, resolveStreamConfig(boot.config.stream));
					seed = {
						...(publication.seed === true ? {} : publication.seed),
						locations: publishedSeedLocationsFor(read, stream),
						...(publication.fetch === undefined ? {} : {fetch: publication.fetch}),
					};
				}
			}
			// BEFORE the generation is built, and therefore before it loads: a fold that
			// starts first would find an empty subtree, index into it, and the install would
			// then be refused as `subtree-not-empty` -- loudly and as data, but too late.
			if (seed) await installSeed(seed, boot.source, boot.config);
		},

		/**
		 * THE SNAPSHOT `createState` IS HANDED, for the generation the boot builds, or
		 * `undefined` where the host was given no publication.
		 *
		 * Chosen by the identity the generation WILL be registered under: the bundle's
		 * bytes, or an identity the arrival handed over. A module arrival has none yet,
		 * so it is refused by name rather than matched on half its generation.
		 * `replaceLocal` is `true` only when a switch rebuilds the generation, which then
		 * reports nothing here: the switch reports once it has taken.
		 */
		snapshotFor(
			replaceLocal: boolean,
		): ((generation: {stream: string; processor: string | undefined}) => PublicationSnapshot | undefined) | undefined {
			const index = read;
			if (!index) return undefined;
			return (generation) => {
				const chosen = publishedSnapshotFor(index, generation);
				if (!replaceLocal) report.publication(chosen.state);
				// The snapshot a returning tab may later SWITCH to, kept for that decision.
				bootSnapshot = chosen.snapshot;
				return chosen.snapshot ? {...chosen.snapshot, replaceLocal} : undefined;
			};
		},

		/** A container was opened over the boot's generation: the catch-up is measured afresh. */
		containerOpened(): void {
			measured = {blocks: 0, ms: 0};
		},

		/**
		 * ONE ADVANCE, and the switch where it applies.
		 *
		 * The step every driver takes (`Indexer.indexMore`), with the two decisions
		 * ADR-0096 puts here: a node that refuses the catch-up as an archive refusal,
		 * and a catch-up estimated over the budget. `switched` says the answer is the
		 * cursor the REBUILT container loaded, so the caller skips whatever it would
		 * have derived from the abandoned one. `pointerMoved` is the caller's own
		 * test of whether a promotion happened during the advance, in which case the
		 * cycle's figures belong to a retired generation and are not measured.
		 */
		async advance(
			container: Indexer<ABI, any>,
			host: SnapshotSwitchHost<ABI>,
			pointerMoved: () => boolean,
		): Promise<{lastSync: LastSync<ABI>; switched: boolean}> {
			const before = container.canonical.lastSync?.lastToBlock;
			const started = performance.now();
			let lastSync: LastSync<ABI>;
			try {
				lastSync = await container.indexMore();
			} catch (err) {
				// The node will not serve the catch-up at all: the snapshot, where there is a
				// usable one, is the only way forward. Where there is none the refusal goes on
				// exactly as it always did.
				if (isArchiveRefusal(err)) {
					const switched = await switchTo({reason: 'archive-refused'}, host);
					if (switched) return {lastSync: switched, switched: true};
				}
				throw err;
			}
			if (!pointerMoved()) {
				const overBudget = measure(before, lastSync, performance.now() - started);
				if (overBudget) {
					const switched = await switchTo({reason: 'over-budget', ...overBudget}, host);
					if (switched) return {lastSync: switched, switched: true};
				}
			}
			return {lastSync, switched: false};
		},

		switchTo,

		/** The host starts over (a `dispose` before a later `init`): a later boot gets its own lookup and its own try. */
		reset(): void {
			read = undefined;
			bootSnapshot = undefined;
			tried = false;
			measured = {blocks: 0, ms: 0};
		},
	};

	/**
	 * MEASURE ONE ADVANCE OF A CATCH-UP, and say whether the rest of it is over budget.
	 *
	 * The estimate is the loop's own arithmetic over what it has observed: the blocks
	 * the canonical generation's advances covered since the container opened, and the
	 * time they took (fetching and folding both, since both are what the user waits
	 * for), extrapolated over the rest of the gap to the tip.
	 *
	 * Only a catch-up that COULD switch is measured: the budget is not `'always'`, the
	 * publication named a snapshot for this generation, the switch has not been tried,
	 * and the cursor is still behind the snapshot. Past the snapshot there is nothing
	 * to switch to, however long the rest takes.
	 */
	function measure(
		before: number | undefined,
		after: LastSync<ABI>,
		elapsedMs: number,
	): {estimateSeconds: number; budgetSeconds: number} | undefined {
		if (budget === 'always' || !bootSnapshot || tried || before === undefined) {
			return undefined;
		}
		if (after.lastToBlock >= bootSnapshot.entry.takenAt.number) {
			return undefined;
		}
		measured.blocks += Math.max(0, after.lastToBlock - before);
		measured.ms += Math.max(0, elapsedMs);
		const remaining = after.latestBlock - after.lastToBlock;
		if (remaining <= 0 || measured.blocks === 0) {
			return undefined;
		}
		const estimateSeconds = (remaining * measured.ms) / measured.blocks / 1000;
		return estimateSeconds > budget ? {estimateSeconds, budgetSeconds: budget} : undefined;
	}
}
