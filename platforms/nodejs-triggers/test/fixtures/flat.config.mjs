// the one-app shape the trigger service took before `apps` (etherfold ADR-0101), now refused
export default {
	name: 'board',
	chainId: '1',
	etherfold: {url: 'http://etherfold.test', indexer: 'board'},
	gate: {rpcUrl: 'http://rpc.test', depth: 12},
	triggers: {events: {}},
	actions: {},
};
