// Make something happen on chain for the indexer to fold:
//
//   pnpm activity                      mint a new token to account #1
//   pnpm activity transfer <id>        move token <id> from account #1 to account #2
//   pnpm activity approve <id>         account #1 approves account #2 for token <id>
import {readFile} from 'node:fs/promises';
import {rpc, send, word} from './rpc.mjs';

const {address} = JSON.parse(await readFile(new URL('../src/deployment.json', import.meta.url), 'utf8'));
const accounts = await rpc('eth_accounts');
const [owner, other] = [accounts[1], accounts[2]];
const [what = 'mint', id = String(Date.now() % 1_000_000)] = process.argv.slice(2);

// function selectors, as `cast sig` prints them
const SELECTORS = {mint: '0x40c10f19', transfer: '0xbeabacc8', approve: '0x095ea7b3'};

let data;
let from = owner;
if (what === 'mint') data = SELECTORS.mint + word(owner) + word(id);
else if (what === 'transfer') data = SELECTORS.transfer + word(owner) + word(other) + word(id);
else if (what === 'approve') data = SELECTORS.approve + word(other) + word(id);
else throw new Error(`unknown activity "${what}": use mint, transfer or approve`);

const receipt = await send({from, to: address, data});
console.log(`${what} ${id}: block ${Number(receipt.blockNumber)}`);
