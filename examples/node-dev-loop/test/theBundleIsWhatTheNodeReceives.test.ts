import {loadProcessorArtifact} from '@etherfold/utils';
import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import deployment from '../src/deployment.json' with {type: 'json'};

// What `pnpm upload` sends is `dist/processor.bundle.js` (built by `pretest`). A node
// loads it with the same loader, so this is the check a node would make, run where a
// broken example is noticed: the repo's gate.

describe('the bundle this example uploads', () => {
	it('is self-contained, makes a processor, and carries the contract it indexes', async () => {
		const bytes = new Uint8Array(await readFile(new URL('../dist/processor.bundle.js', import.meta.url)));
		const loaded = await loadProcessorArtifact(bytes);
		expect(loaded.status, JSON.stringify(loaded)).toBe('instantiated');
		if (loaded.status !== 'instantiated') return;

		expect(loaded.identity).toMatch(/^sha256:[0-9a-f]{64}$/);
		const contracts = (loaded.processorModule as {contractsDataPerChain?: Record<string, {address: string}[]>})
			.contractsDataPerChain;
		expect(contracts?.[deployment.chainId]?.[0]?.address).toBe(deployment.address);
		expect((loaded.processor as {entities: {name: string}[]}).entities.map((entity) => entity.name)).toEqual([
			'nft',
			'counter',
		]);
	});
});
