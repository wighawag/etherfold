import type {HostAccess, MessageEndpoint} from '../../src/index.js';

/**
 * THE TWO ENDS OF ONE WIRE, as each side's `HostAccess`.
 *
 * A `MessageChannel` is the same structured-clone boundary a worker is, so
 * nothing that could not cross to a worker crosses here either. What it does not
 * have is a SECOND EXECUTION CONTEXT -- so a host over it names itself the
 * `main-thread` shape, honestly, rather than pretending to be a worker it is
 * not. The real worker runs under Playwright (`browser/*.spec.ts`), which is
 * where "the UI thread is not doing the work" becomes a fact about two contexts.
 */
export function wire(): {host: HostAccess; tab: HostAccess; tabEndpoint: MessageEndpoint; close: () => void} {
	const channel = new MessageChannel();
	const hostEnd = channel.port1 as unknown as MessageEndpoint;
	const tabEnd = channel.port2 as unknown as MessageEndpoint;
	const close = () => {
		channel.port1.close();
		channel.port2.close();
	};
	return {
		host: {host: 'main-thread', endpoint: hostEnd},
		tab: {host: 'main-thread', endpoint: tabEnd, close},
		tabEndpoint: tabEnd,
		close,
	};
}
