import type {MessageEndpoint} from '../../src/index.js';

/**
 * THIS NODE GLOBAL, MADE TO LOOK LIKE A `SharedWorkerGlobalScope`, and put back
 * afterwards.
 *
 * A shared worker's entry point is reached through a `connect` event, and node's
 * global is not an `EventTarget` at all, so what is installed here is the two
 * things the entry helper actually uses: the `onconnect` slot that says this
 * scope HAS a connect interface, and the listener registration it attaches to.
 * `connect()` then delivers a client the way a browser does -- one event carrying
 * one port.
 */
export function sharedWorkerScope(): {connect: (port: MessageEndpoint) => void; restore: () => void} {
	type Scope = {onconnect?: unknown; addEventListener?: unknown; removeEventListener?: unknown};
	const scope = globalThis as Scope;
	const before = {
		hadOnconnect: 'onconnect' in scope,
		addEventListener: scope.addEventListener,
		removeEventListener: scope.removeEventListener,
	};
	const listeners = new Set<(event: {ports: MessageEndpoint[]}) => void>();
	scope.onconnect = null;
	scope.addEventListener = (type: string, listener: (event: {ports: MessageEndpoint[]}) => void) => {
		if (type === 'connect') listeners.add(listener);
	};
	scope.removeEventListener = (_type: string, listener: (event: {ports: MessageEndpoint[]}) => void) => {
		listeners.delete(listener);
	};
	return {
		connect(port) {
			for (const listener of [...listeners]) listener({ports: [port]});
		},
		restore() {
			if (!before.hadOnconnect) delete scope.onconnect;
			if (before.addEventListener === undefined) delete scope.addEventListener;
			else scope.addEventListener = before.addEventListener;
			if (before.removeEventListener === undefined) delete scope.removeEventListener;
			else scope.removeEventListener = before.removeEventListener;
		},
	};
}
