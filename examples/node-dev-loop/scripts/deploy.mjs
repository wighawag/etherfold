// Deploy contracts/Token.json to the local chain and write src/deployment.json, which
// the processor bundles as the contract it indexes. On a fresh anvil the first
// deployment from its first account always lands at the same address, so re-running
// this after restarting anvil rewrites the same file and the next upload is
// `unchanged`; a different address is a different source, so a new stream.
import {readFile, writeFile} from 'node:fs/promises';
import {rpc, send, RPC} from './rpc.mjs';

const artifact = JSON.parse(await readFile(new URL('../contracts/Token.json', import.meta.url), 'utf8'));
const [from] = await rpc('eth_accounts');
const receipt = await send({from, data: artifact.bytecode});
const chainId = String(Number(await rpc('eth_chainId')));
const deployment = {chainId, address: receipt.contractAddress, startBlock: Number(receipt.blockNumber)};
await writeFile(new URL('../src/deployment.json', import.meta.url), JSON.stringify(deployment, null, '\t') + '\n');
console.log(`Token deployed at ${deployment.address} on chain ${chainId} (block ${deployment.startBlock}), via ${RPC}`);
