import {serveProvider, type RequestProvider} from '@eip-1193/over-port';

/**
 * THE CHAIN, AS A TAB HANDS IT TO A HOST IN ANOTHER CONTEXT.
 *
 * A provider is an object with methods, so it cannot be structured-cloned into a
 * worker; a `MessagePort` can be TRANSFERRED into one. So what crosses is always
 * a port, speaking `@eip-1193/over-port`, and what a tab may hand over is one of
 * three things:
 *
 * - **a provider object** (a wallet's `window.ethereum`, a viem transport's
 *   provider): the port serves it on a fresh `MessageChannel` itself, and every
 *   request the host makes passes through this tab as a message (the work stays
 *   in the worker);
 * - **a `MessagePort` whose other end is already served elsewhere**, typically by
 *   a worker running a node (`webevm`): requests then go worker to worker and this
 *   tab relays nothing. A port can be transferred ONCE, so a host that dies and is
 *   restarted cannot be handed it again; see the factory form;
 * - **a function returning such a port**, called once per host the port obtains
 *   (the first one, and every restart), which is the form that survives a restart
 *   for the provider-in-another-worker case.
 */
export type IndexerProvider = RequestProvider | MessagePort | (() => MessagePort);

/** A provider handed over for ONE host: the port to transfer, and how to let go of what this tab serves. */
export type ProviderHandover = {
	readonly port: MessagePort;
	/** Stop serving, where this tab serves anything. Idempotent. */
	release(): void;
};

/**
 * HAND `provider` OVER for one host, or refuse naming why.
 *
 * `used` says whether a bare `MessagePort` was already transferred to an earlier
 * host, which is the one form that cannot be handed over twice: the port now
 * belongs to that host's context, and there is no copy of it on this side.
 */
export function handOverProvider(provider: IndexerProvider, used: boolean): ProviderHandover {
	if (typeof provider === 'function') {
		const port = provider();
		if (!isMessagePort(port)) {
			throw new TypeError(
				`the provider factory handed to connectToIndexerHost() returned something that is not a MessagePort. It ` +
					`is called once per host (the first, and every restart), and must answer a fresh port whose other end ` +
					`is served by \`serveProvider\` from '@eip-1193/over-port'.`,
			);
		}
		return {port, release: () => undefined};
	}
	if (isMessagePort(provider)) {
		if (used) {
			throw new Error(
				`the provider MessagePort handed to connectToIndexerHost() was already transferred to the host that died, ` +
					`so it cannot be handed to its replacement. Hand over a FUNCTION that returns a fresh port instead ` +
					`(\`provider: () => portServedByYourNodeWorker()\`), which is called once per host.`,
			);
		}
		return {port: provider, release: () => undefined};
	}
	if (typeof (provider as RequestProvider | undefined)?.request !== 'function') {
		throw new TypeError(
			`the provider handed to connectToIndexerHost() is neither an EIP-1193 provider (it has no \`request\`), a ` +
				`MessagePort, nor a function returning one.`,
		);
	}
	const channel = new MessageChannel();
	const served = serveProvider(provider, channel.port1);
	let released = false;
	return {
		port: channel.port2,
		release() {
			if (released) return;
			released = true;
			served.close();
			// Closing OUR end is what the host's end can observe (a `close` event, where
			// the engine fires one), so a host holding it is not left waiting on it.
			channel.port1.close();
		},
	};
}

/** A `MessagePort`, recognised by what it DOES rather than by `instanceof`, which differs between realms. */
function isMessagePort(value: unknown): value is MessagePort {
	if (typeof MessagePort !== 'undefined' && value instanceof MessagePort) return true;
	const candidate = value as {postMessage?: unknown; start?: unknown; close?: unknown; request?: unknown} | null;
	return (
		typeof candidate === 'object' &&
		candidate !== null &&
		typeof candidate.postMessage === 'function' &&
		typeof candidate.start === 'function' &&
		typeof candidate.close === 'function' &&
		typeof candidate.request !== 'function'
	);
}
