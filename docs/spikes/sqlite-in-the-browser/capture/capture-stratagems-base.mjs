/**
 * Capture the stratagems-on-Base log stream ONCE, as a replayable fixture.
 *
 * This is the only script in the spike that talks to a node. Everything else
 * replays `packages/conformance-workload-stratagems/fixtures/stratagems-base.stream.json` offline, so that every
 * candidate sees the same bytes and no measurement is at the mercy of a
 * rate limiter.
 *
 *   npx tsx capture/capture-stratagems-base.mjs [--deployment <dir>] [--to-block <n>]
 *
 * Needs `CHAIN_8453` in the repo's `.env.local` (a Base JSON-RPC endpoint).
 *
 * WHICH DEPLOYMENT. stratagems has TWO deployment folders on Base (chainId
 * 8453): `base/`, an early one that saw 45 logs and was abandoned, and
 * `alpha1/`, which is the launched game (about 26,300 logs). The folder name is
 * misleading and the default here is `alpha1` deliberately: `--deployment base`
 * still captures the early one, and both `.chain` files say 8453, which is how
 * the confusion is checkable rather than arguable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {captureStream} from '../../../../packages/core/dist/index.js';
// The fixture-file IO now lives in the workload package's own source (it moved
// when `@etherfold/fs` was deleted), so this script runs under tsx to read it:
// the run/ scripts already import that package's TS sources the same way.
import {saveStreamFixture} from '../../../../packages/conformance-workload-stratagems/src/fixture-file.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const STRATAGEMS = path.resolve(process.env.STRATAGEMS_REPO ?? `${process.env.HOME}/dev/github/wighawag/stratagems`);

const deploymentArg = process.argv.indexOf('--deployment');
const DEPLOYMENT = deploymentArg === -1 ? 'alpha1' : process.argv[deploymentArg + 1];
const DEPLOYMENTS = path.join(STRATAGEMS, 'contracts/deployments', DEPLOYMENT);
// Gzipped for the launched game (33.8 MB of JSON, 1.05 MB compressed, so the
// compressed form saves 33 MB in every working tree); plain JSON for the tiny
// abandoned deployment, which is small enough to stay readable and diffable.
const OUT = path.join(
	HERE,
	`../../../../packages/conformance-workload-stratagems/fixtures/stratagems-${DEPLOYMENT}.stream.json${DEPLOYMENT === 'base' ? '' : '.gz'}`,
);

/**
 * The last block of the capture, per deployment. Pinned, never `latest`: a
 * fixture is a snapshot, and one whose upper bound was "whenever it ran" cannot
 * be re-captured and compared against itself.
 *
 * `alpha1` is pinned past its last observed activity (Stratagems 23,303,136 and
 * GemsGenerator 21,769,963, both checked 2026-08-22), with room to spare, so a
 * re-capture at a later chain head still produces the same file.
 */
const DEFAULT_TO_BLOCK = {alpha1: 23_400_000, base: 11_800_000}[DEPLOYMENT] ?? 23_400_000;

function envValue(key) {
	const text = fs.readFileSync(path.join(REPO, '.env.local'), 'utf-8');
	const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
	if (!match) throw new Error(`${key} not found in .env.local`);
	return match[1].trim().replace(/^["']|["']$/g, '');
}

function deployment(name) {
	const json = JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS, `${name}.json`), 'utf-8'));
	return {
		abi: json.abi,
		address: json.address.toLowerCase(),
		startBlock: parseInt(json.receipt.blockNumber, 16),
	};
}

function gitCommit(repo) {
	try {
		return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding: 'utf-8'}).trim();
	} catch {
		return 'unknown';
	}
}

const toBlockArg = process.argv.indexOf('--to-block');
const toBlock = toBlockArg === -1 ? DEFAULT_TO_BLOCK : Number(process.argv[toBlockArg + 1]);

const url = envValue('CHAIN_8453');
const provider = {
	async request(args) {
		const response = await fetch(url, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({jsonrpc: '2.0', id: 1, ...args}),
		});
		const json = await response.json();
		if (json.error) {
			const error = new Error(json.error.message);
			error.code = json.error.code;
			throw error;
		}
		return json.result;
	},
};

// The same three contracts the stratagems indexer is configured with.
const contracts = [deployment('Stratagems'), deployment('Gems'), deployment('GemsGenerator')];
const source = {chainId: '8453', contracts};

const chainIdHex = await provider.request({method: 'eth_chainId'});
if (parseInt(chainIdHex, 16).toString() !== source.chainId) {
	throw new Error(`CHAIN_8453 points at chain ${parseInt(chainIdHex, 16)}, not Base`);
}
const latestHex = await provider.request({method: 'eth_blockNumber'});
const latestBlock = parseInt(latestHex, 16);
if (latestBlock < toBlock) {
	throw new Error(`chain is only at ${latestBlock}, cannot capture up to ${toBlock}`);
}

const started = Date.now();
const fixture = await captureStream(provider, source, {
	toBlock,
	streamConfig: {finality: 12},
	// The provider caps a response by RESULT COUNT, not only by block range, and
	// the reward events arrive in dense bursts. Start wide, and let the fetcher's
	// own halving find the width; it needs more retries than the default 3 to get
	// from 100k blocks down to the few thousand those bursts allow.
	fetch: {maxBlocksPerFetch: 100_000, numRetry: 12},
	provenance: {
		what: `stratagems on Base (deployments/${DEPLOYMENT}): Stratagems + Gems + GemsGenerator, every log in the range`,
		deployment: DEPLOYMENT,
		stratagemsRepo: 'github.com/wighawag/stratagems',
		stratagemsCommit: gitCommit(STRATAGEMS),
		contracts: contracts.map((c) => ({address: c.address, startBlock: c.startBlock})),
		node: new URL(url).host,
		chainHeadAtCapture: latestBlock,
		capturedBy: 'docs/spikes/sqlite-in-the-browser/capture/capture-stratagems-base.mjs',
	},
	onProgress: ({fromBlock, toBlock: to, events, totalEvents}) => {
		process.stdout.write(`  ${fromBlock} -> ${to}: ${events} events (${totalEvents} total)\n`);
	},
});

/**
 * Drop the ENCODED form of what is already decoded.
 *
 * **PASS `--full` IF YOU ARE RE-CAPTURING THE COMMITTED alpha1 FIXTURE.** That
 * file carries `data` and `topics` since 2026-09-06 and a re-capture without the
 * flag would silently regress it: an event with no raw log cannot be re-decoded
 * (ADR-0034), so a stream seeded from such a capture is CLEARED on load, and
 * seeding a generation from a published stream is the whole point of ADR-0063.
 * The default stays trimmed because a decode-only capture is still the cheaper
 * artifact for anything that only ever REPLAYS one into a processor.
 *
 * `data` and `topics` are the wire form of `args`, and `args` is what a
 * processor reads, so keeping both takes this capture from 22.2 MB to 33.8 MB.
 * They are recoverable from the chain at any time, because the provenance says
 * exactly which contracts and which blocks to re-fetch.
 *
 * What is NOT dropped either way: block number and hash (grouping and reorg
 * identity), log index and transaction coordinates (ordering), address,
 * `removed`, and the block timestamp.
 */
const full = process.argv.includes('--full');
const trimmed = full
	? fixture
	: {
			...fixture,
			provenance: {...fixture.provenance, omittedFields: ['data', 'topics']},
			eventStream: fixture.eventStream.map(({data, topics, ...event}) => event),
		};

saveStreamFixture(OUT, trimmed);

const byEvent = {};
for (const event of trimmed.eventStream) {
	const name = event.eventName ?? `unparsed(${event.decodeError})`;
	byEvent[name] = (byEvent[name] ?? 0) + 1;
}
const blocks = new Set(fixture.eventStream.map((e) => e.blockNumber));
console.log(`\ncaptured ${fixture.eventStream.length} events in ${blocks.size} blocks, ${Date.now() - started} ms`);
console.log(byEvent);
console.log(`written to ${path.relative(REPO, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
