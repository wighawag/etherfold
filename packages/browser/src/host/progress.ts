import {writable, type Readable} from 'sveltore';
import type {HostProgress} from './envelope.js';

/**
 * THE SMALL HELPER FOR THE COMMON CASE: the pushed signal, as something a
 * framework can bind to.
 *
 * ADR-0082 decides that status is PUSHED and that an app builds whatever
 * reactive wrapper its framework wants from that signal. This is that wrapper
 * for the app that just wants a progress bar and should not be obliged to write
 * one: the same `Readable` shape `createIndexerState` publishes its stores as
 * (`sveltore`, which `use-stores` bridges to React), holding whatever the host
 * last said.
 *
 * ```svelte
 * const progress = createProgressReadable(indexer);
 * ...
 * {#if $progress}
 *   {$progress.phase === 'at-tip' ? 'live' : `syncing, ${$progress.blocksBehindTip} blocks behind`}
 * {/if}
 * ```
 *
 * ## It is a VIEW, and never a second source of truth
 *
 * What it holds is the host's own last report, kept by reference and replaced
 * wholesale. It derives nothing, merges nothing into what it already had, and
 * invents nothing while it is waiting: it is `undefined` until the host has
 * answered, because "we have not been told yet" is a real state and a synthetic
 * zero would render as a fold that has finished.
 *
 * That is what keeps the helper OPTIONAL rather than load-bearing. An app with
 * its own store, its own signal library or its own framework subscribes to
 * `port.onProgress` directly and loses nothing, which is the property that makes
 * this a convenience: there is exactly one place progress is decided, and it is
 * the host.
 */
export type ProgressReadable = Readable<HostProgress | undefined> & {
	/**
	 * The host's last report, or `undefined` before it has answered. The same
	 * convention `createIndexerState`'s stores use for reading without subscribing.
	 */
	readonly $state: HostProgress | undefined;
	/**
	 * Stop following. The port's subscription is released, so a host with nothing
	 * else listening stops posting.
	 */
	close(): void;
};

/** What this needs of a port: the push, and nothing else. */
export type PortWithProgress = {
	onProgress(listener: (progress: HostProgress) => void): () => void;
};

/**
 * FOLLOW A HOST'S PROGRESS as a reactive value.
 *
 * It subscribes IMMEDIATELY rather than on the first `subscribe`, so the round
 * trip that fetches the current progress is in flight while the app is still
 * wiring itself up rather than on the first thing a user waits for -- the same
 * choice `createPortReadSurface` makes with its declarations check.
 */
export function createProgressReadable(port: PortWithProgress): ProgressReadable {
	let $state: HostProgress | undefined;
	const store = writable<HostProgress | undefined>(undefined);

	const stop = port.onProgress((progress) => {
		// Held by REFERENCE, exactly as it arrived. Nothing here composes a value
		// out of what it already had, which is what makes this a view.
		$state = progress;
		store.set(progress);
	});

	return {
		get $state() {
			return $state;
		},
		subscribe: store.subscribe,
		close: stop,
	};
}
