import eip721 from './eip721.js';
import {NFTProcessor} from './entities.js';

/**
 * The same processor, run from a terminal instead of from a tab.
 *
 * `entities.ts` is UNCHANGED and is imported as-is: this file adds no handler,
 * no declaration and no backend, because there is nothing about the CLI for a
 * processor to know. It exists only to say the two things a module has to say to
 * a host that loads it -- WHICH processor to run, and what to index -- neither of
 * which a browser page needs, since an app passes both at the call site
 * (`browser/main.ts`).
 *
 * THIS FILE IS NOT WHAT THE CLI IS POINTED AT. It is what the BUNDLE is built
 * FROM: it imports its ABI and its sibling module, so its dependency closure is
 * not in it and there is nothing to hash. `pnpm build:bundle` flattens it into
 * `dist/cli.bundle.js`, whose bytes ARE this deployment's identity (ADR-0086),
 * and that is the path `--processor` names.
 *
 * ```sh
 * pnpm --filter event-processor-nfts build
 * NFT_CONTRACT=0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d NFT_START_BLOCK=21000000 \
 *   pnpm --filter event-processor-nfts build:db -n https://rpc.mevblocker.io
 * ```
 *
 * See the README for what that prints and what lands in the database.
 */

/**
 * The processor, handed over bare.
 *
 * What travels is the AUTHORING object -- declarations plus handlers -- because
 * WHERE the state lives is the deployment's choice: the CLI builds the store
 * named by `--store` and wraps this in the runtime that writes to it. It used to
 * be wrapped in a `{kind: 'entities', processor}` tag saying which of two
 * authoring paths this was; there is one (ADR-0037), so there is nothing left to
 * say.
 */
export const createProcessor = () => NFTProcessor;

/**
 * WHAT to index, per chain.
 *
 * Keyed by chain id because that is what a host can resolve for itself: the CLI
 * asks the node which chain it is on and picks the entry. One collection rather
 * than every address, because a terminal has no topic filter to narrow with (the
 * browser app filters `Transfer` on one account's topics, which is a stream
 * config an app passes and a flag cannot express) -- and "every ERC-721 transfer
 * on mainnet" is not a demo, it is a bill.
 *
 * Both values come from the environment so the command in the README points
 * wherever a reader wants. The default is Bored Ape Yacht Club, and the default
 * start block is deliberately recent rather than the deployment block: the first
 * sync is what a reader waits for.
 */
const address = (process.env.NFT_CONTRACT ?? '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d') as `0x${string}`;
const startBlock = Number(process.env.NFT_START_BLOCK ?? 21_000_000);

export const contractsDataPerChain = {'1': [{abi: eip721, address, startBlock}]};

/** Re-exported so a reader importing this module gets the same names the browser app uses. */
export {abi, NFTProcessor, readableTokenID} from './entities.js';
