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
 *
 * ## What this is NOT, now that the third shape has shipped
 *
 * It is the WORKER hosts' driver (`serveIndexerHost`) reached over a local wire,
 * labelled by the context it happens to run in. It is not the main-thread
 * HOSTING SHAPE, which is `createIndexerState(...).mainThreadHost()` -- one host,
 * the app's own, with no second container beside it (ADR-0082). That shape is
 * driven by `test/theThreeHostingShapesRunOneImplementation.test.ts`, which runs
 * the shared behaviour suite against it.
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
