import {describe, expect, it} from 'vitest';
import {rpcGate} from '../src/index.js';
import {recordingTarget} from './utils/target.js';

// ---------------------------------------------------------------------------
// THE SAFE LANE'S GATE (etherfold ADR-0007): the `finalized` tag, or a fixed
// depth below the tip on a chain without one. The consumer's decision, read
// from the chain's own node.
// ---------------------------------------------------------------------------

function node(answers: Record<string, unknown>) {
	return recordingTarget((request) => {
		const {method, id} = request.body as {method: string; id: number};
		const result = answers[method];
		return result instanceof Error
			? {status: 200, body: {jsonrpc: '2.0', id, error: {code: -32602, message: result.message}}}
			: {status: 200, body: {jsonrpc: '2.0', id, result}};
	});
}

describe('rpcGate', () => {
	it('gates at the finalized block', async () => {
		const target = node({eth_getBlockByNumber: {number: '0x64'}});
		expect(await rpcGate({url: 'https://rpc.test', fetch: target.fetch})()).toBe(100);
		expect(target.requests[0]?.body).toMatchObject({method: 'eth_getBlockByNumber', params: ['finalized', false]});
	});

	it('gates at a fixed depth below the tip when asked to', async () => {
		const target = node({eth_blockNumber: '0x64'});
		expect(await rpcGate({url: 'https://rpc.test', depth: 12, fetch: target.fetch})()).toBe(88);
	});

	it('says what to do when the chain has no finalized tag', async () => {
		const target = node({eth_getBlockByNumber: new Error('invalid block tag')});
		await expect(rpcGate({url: 'https://rpc.test', fetch: target.fetch})()).rejects.toThrow(/set a depth/);
	});

	it('never gates below zero', async () => {
		const target = node({eth_blockNumber: '0x3'});
		expect(await rpcGate({url: 'https://rpc.test', depth: 12, fetch: target.fetch})()).toBe(0);
	});
});
