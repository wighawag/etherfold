import {resolveStreamConfig, streamConfigHashOf} from '@etherfold/core';
import {resolveFetcherHostConfig, type EnvRecord} from '@etherfold/fetcher-host';
import {describe, expect, it} from 'vitest';
import {streamConfigFor} from '../src/folding.js';

// ---------------------------------------------------------------------------
// THE TWO HALVES MUST REACH THE SAME STREAM CONFIG FROM THE SAME ENVIRONMENT
// ---------------------------------------------------------------------------
// The RESOLVED stream config is hashed into the wire identity, so a sending
// `LogFetcher` and a receiving `StreamBuilder` that disagree cannot talk at all:
// the receiver refuses the batch with a `WireContextMismatchError`, which is not
// retryable, so the process exits rather than degrading.
//
// The environment owns the stream settings (`STREAM_FINALITY`,
// `STREAM_ALWAYS_FETCH_TIMESTAMPS`) and the
// commands that hold BOTH halves in one process (`run`, `build`) have to hand
// the same resolved config to each. The failure this pins is that they did not:
// the sender derived its config from the environment while the receiver was
// given a hard-coded empty one, so setting `STREAM_FINALITY` -- the documented
// way to configure it -- made every one of those commands refuse to start.
//
// A merge cannot express this, which is why the fix is a single derivation
// handed to both: an override that spreads OVER the environment can add a key
// but can never say "no finality here", so an empty override read as "use the
// default" was indistinguishable from an absent one.
// ---------------------------------------------------------------------------

const SOURCE = {
	chainId: '1',
	contracts: [{address: '0x0000000000000000000000000000000000000001', startBlock: 0, abi: []}],
};

function envWith(over: EnvRecord = {}): EnvRecord {
	return {
		ETH_NODE_URI: 'http://localhost:8545',
		INDEXING_SOURCE: JSON.stringify(SOURCE),
		...over,
	};
}

/** What the receiving half indexes under, and what the sending half fetches under. */
function bothHalves(env: EnvRecord) {
	const shared = streamConfigFor(env);
	const sender = resolveFetcherHostConfig(env, {stream: shared}).stream;
	return {receiver: shared, sender};
}

describe('the sending and receiving halves agree on the stream config', () => {
	it('agree when the environment says nothing, and take the default', () => {
		const {receiver, sender} = bothHalves(envWith());
		expect(streamConfigHashOf(sender)).toBe(streamConfigHashOf(receiver));
		expect(resolveStreamConfig(receiver).finality).toBe(17);
	});

	it('agree when STREAM_FINALITY is set, and both HONOUR it', () => {
		// The regression: the sender read 25 from the environment and the receiver was
		// handed an empty config that resolved to 17, so the wire identities could
		// never match and `run`/`build` refused to start on any host that set it.
		const {receiver, sender} = bothHalves(envWith({STREAM_FINALITY: '25'}));

		expect(resolveStreamConfig(sender).finality).toBe(25);
		// asserted on the receiver too: agreeing by both IGNORING the variable would
		// satisfy a hash comparison while silently discarding a documented setting
		expect(resolveStreamConfig(receiver).finality).toBe(25);
		expect(streamConfigHashOf(sender)).toBe(streamConfigHashOf(receiver));
	});

	it('agree on the boolean setting as well', () => {
		const {receiver, sender} = bothHalves(envWith({STREAM_ALWAYS_FETCH_TIMESTAMPS: 'true'}));
		expect(streamConfigHashOf(sender)).toBe(streamConfigHashOf(receiver));
		expect(resolveStreamConfig(receiver).alwaysFetchTimestamps).toBe(true);
	});

	it('reach the SAME digest that a split deployment reaches from the same environment', () => {
		// `fetch` on one host and `index` on another are the split shape: `fetch`
		// passes no override at all, so it takes the environment's config directly.
		// That is the digest the combined shape has to match, or the same environment
		// means two different streams depending on how it is deployed.
		const env = envWith({STREAM_FINALITY: '9'});
		const split = resolveFetcherHostConfig(env, {}).stream;
		const {receiver, sender} = bothHalves(env);

		expect(streamConfigHashOf(split)).toBe(streamConfigHashOf(sender));
		expect(streamConfigHashOf(split)).toBe(streamConfigHashOf(receiver));
	});
});
