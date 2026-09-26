import {
	resolveStreamConfig,
	streamDigestOf,
	type Abi,
	type GenerationId,
	type IndexingSource,
	type ProvidedStreamConfig,
	type ReceivingIndexer,
} from '@etherfold/core';
import type {EntityProcessor, WritableStateStore} from '@etherfold/processor-entities';
import type {ReconfigureReport} from '@etherfold/server';
import {loadProcessorArtifact} from '@etherfold/utils';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {foldPartsFor, openIndexingSource} from './folding.js';
import {arrivalQueue, sameIdentity, type ArrivalQueue} from './reconfigure.js';
import type {ExplicitSource, StoreTarget} from './types.js';

const logger = logs('etherfold');

// ---------------------------------------------------------------------------------------------------
// THE UPLOAD: WHAT `POST /{indexer}/admin/upload` ACTUALLY DOES ON THIS PROCESS
// ---------------------------------------------------------------------------------------------------
// The RECEIVING half of The Graph's deploy shape (ADR-0085's amendment of
// 2026-09-22): the BYTES of an already-built bundle arrive, and the generation they
// name is registered BESIDE the incumbent exactly as a re-read registers one
// (`reconfigure.ts`). From there everything is existing machinery: the incumbent
// goes on answering, the successor catches up, and the promotion policy moves the
// pointer.
//
// ## Everything that can refuse happens BEFORE `add`
//
// Not "register, then unwind on failure": a refused upload must leave the registry,
// the slots and the held folds EXACTLY as they were, and an unwind is a second
// write that can itself fail half-way. So the whole of the refusable work is done
// first and `add` is reached only with a generation that is going to be registered:
//
//  1. the LOADER (`loadProcessorArtifact`, `@etherfold/utils`) hashes the bytes,
//     refuses a bundle that is not self-contained with the repository's ONE
//     definition of that (`unresolvedImportsOf`, which `readProcessorPath` shares),
//     and refuses one that throws on evaluation or carries no processor -- as DATA;
//  2. the SOURCE the upload carries is resolved through the route a processor
//     module already supplies its contracts by (`resolveSource`), and a module that
//     carries none is refused: an upload ALWAYS carries its own contracts;
//  3. the CONTRACT MATCH, against a source the OPERATOR configured and nothing else
//     (below);
//  4. the fold parts are assembled the ONE way this deployment assembles them
//     (`foldPartsFor`), so the successor lands in the same database under the same
//     namespacing, retention and finality.
//
// `add` itself refuses what it refuses (a cap) before its registry write, which is
// the same guarantee the re-read rests on.
//
// ## The IDENTITY is this process's, from the bytes
//
// The loader's hash of the octets received (ADR-0086). Nothing the sender says about
// identity is read, and the route carries nothing it could say it with. The same
// bytes go to `add` beside that identity, so the generation's row KEEPS exactly the
// code that names it (ADR-0092) through the one registration path every Node
// generation takes -- there is no second route to the store.
//
// ## The CONTRACT MATCH applies only to a source the OPERATOR configured
//
// Decided by the maintainer on 2026-09-26 (ADR-0085's relocated decisions): a
// source changes LEGITIMATELY, in development and in production -- a new event a
// new handler needs, a contract upgraded with new events. So:
//
//  - a node STARTED with an explicit source (`--deployments` or `INDEXING_SOURCE`)
//    refuses an upload whose resolved source differs from it, BY NAME (what the
//    upload carries against what the node was configured with). "Differs" is the
//    SOURCE half of the stream digest: both are digested under this deployment's
//    one stream config, so equal digests are the same chain, contracts, events and
//    start blocks, and nothing else counts (a renamed non-indexed parameter moves
//    no stream, exactly as it moves none on the disk path);
//  - a node whose source came from its processor module is NOT the operator's
//    choice to defend, so an upload carrying different contracts registers a
//    successor on its NEW stream, exactly as a re-read after a filter change does,
//    with the same consequences for the incumbent and the fetcher.
//
// The successor is always registered on the UPLOAD's own source, the contracts its
// handlers were written for: where a configured source matched, the two name one
// stream, and the upload's ABI is what its handlers decode against.
// ---------------------------------------------------------------------------------------------------

/** A source the OPERATOR configured at start: where it came from, and what it resolved to. */
export type ConfiguredSource<ABI extends Abi = Abi> = {
	readonly origin: ExplicitSource<ABI>;
	readonly source: IndexingSource<ABI>;
};

/** What a running `run` hands over so that it can receive an upload. */
export type UploadContext<ABI extends Abi = Abi, ProcessResultType = unknown> = {
	/** The chain, for the one step that may cost an `eth_chainId` call: resolving the contracts an upload carries. */
	provider: EIP1193ProviderWithoutEvents;
	/** The ONE handle this process folds into. An upload lands in it and never opens another. */
	db: RemoteSQL;
	/** Where state goes, exactly as this process resolved it at start: the successor lands under the same rules. */
	destination: StoreTarget;
	/**
	 * The stream config this process came up with, AS PROVIDED (`streamConfigFor`), and
	 * what `add` is handed. Taken from the start rather than re-read: an upload changes
	 * the processor and the contracts it carries, and nothing else about the deployment.
	 */
	stream: ProvidedStreamConfig;
	/** The generations this process holds: what an upload adds to, beside the live fold. */
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>;
	/**
	 * The source the operator CONFIGURED at start (`--deployments` or `INDEXING_SOURCE`),
	 * which an upload must match; ABSENT where the source came from the processor module,
	 * and then an upload's own contracts stand (see the header).
	 */
	configured?: ConfiguredSource<ABI>;
};

/**
 * Build the UPLOAD this process answers `POST /{indexer}/admin/upload` with.
 *
 * Calls wait in `queue`, which a process SHARES with its re-read (`arrivalQueue`), so
 * no two arrivals decide "is this identity already held" against one registry at once.
 */
export function uploaderFor<ABI extends Abi, ProcessResultType>(
	held: UploadContext<ABI, ProcessResultType>,
	queue: ArrivalQueue = arrivalQueue(),
): (bundle: Uint8Array) => Promise<ReconfigureReport> {
	const receive = async (bundle: Uint8Array): Promise<ReconfigureReport> => {
		let wanted: GenerationId;
		let source: IndexingSource<ABI>;
		let parts: Awaited<ReturnType<typeof foldPartsFor<ABI, ProcessResultType>>>;
		try {
			// 1. THE BYTES, as data: hashed, checked for self-containment, then evaluated.
			const artifact = await loadProcessorArtifact<ABI, ProcessResultType, EntityProcessor<ABI, any>>(bundle);
			if (artifact.status === 'refused') {
				return refused(
					`the uploaded bundle ${artifact.identity} was refused (${artifact.reason}): ${artifact.why} ` +
						`Nothing was registered.`,
				);
			}
			const streamConfig = resolveStreamConfig(held.stream);
			// 2. THE CONTRACTS IT CARRIES, through the route a processor module already
			// supplies them by. A module that carries none is refused here by the same
			// words a start-up uses.
			source = await openIndexingSource<ABI, ProcessResultType>(
				{from: 'processor-module'},
				artifact.processorModule,
				held.provider,
			);
			// 3. THE MATCH, against a source the operator configured and nothing else.
			if (held.configured) {
				const carried = streamDigestOf(source, streamConfig);
				const configured = streamDigestOf(held.configured.source, streamConfig);
				if (carried !== configured) {
					return refused(
						`the uploaded bundle ${artifact.identity} carries a different source from the one this node was ` +
							`started with, so it was refused and nothing was registered. The upload carries ` +
							`${describeSource(source)}; this node was configured with ${describeSource(held.configured.source)} ` +
							`(${describeOrigin(held.configured.origin)}). A source the operator configured is what this node ` +
							`indexes, and a processor must not fold contracts it was not written for: upload a bundle built ` +
							`against that source, or restart the node with the source this bundle carries.`,
					);
				}
			}
			// 4. THE FOLD PARTS, the one way this deployment builds them, named by the
			// loader's hash of the bytes and carrying those bytes to the registration.
			parts = await foldPartsFor<ABI, ProcessResultType>(
				artifact.processor,
				held.destination,
				held.db,
				streamConfig.finality,
				{identity: artifact.identity, bundle},
			);
			wanted = {stream: streamDigestOf(source, streamConfig), processor: parts.processorIdentity};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`upload: the uploaded bundle could not be prepared, and nothing changed`, err);
			return refused(message);
		}

		// A FOLD THIS PROCESS ALREADY HOLDS IS NOT ADDED AGAIN, for the reason the re-read
		// gives: `add` would build a second fold over the same state.
		if (held.container.held().some((fold) => sameIdentity(fold.record, wanted))) {
			logger.info(
				`upload: the uploaded bytes name {stream: ${wanted.stream}, processor: ${wanted.processor}}, which this ` +
					`deployment already folds, so NOTHING was registered`,
			);
			return {
				arrival: 'upload',
				outcome: 'unchanged',
				generation: wanted,
				message:
					`the uploaded bundle names the generation this deployment is already folding (processor ` +
					`${wanted.processor}), so nothing was registered and nothing changed. A generation is identified by ` +
					`the hash of its bundle's bytes (ADR-0086), and these are the bytes already running here.`,
			};
		}

		try {
			const fold = await held.container.add({source, stream: held.stream, ...parts.generation});
			const registered: GenerationId = {stream: fold.record.stream, processor: fold.record.processor};
			logger.info(
				`upload: registered {stream: ${registered.stream}, processor: ${registered.processor}} BESIDE the ` +
					`generation answering reads, which keeps its own state and goes on answering.`,
			);
			return {arrival: 'upload', outcome: 'registered', generation: registered};
		} catch (err) {
			// A CAP is what lands here, and `add` refuses it before its registry write.
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`upload: the generation the uploaded bundle names could not be registered`, err);
			return refused(message);
		}
	};

	return (bundle) => queue(() => receive(bundle));
}

/** The `failed` arm, named as the upload's. */
function refused(message: string): ReconfigureReport {
	return {arrival: 'upload', outcome: 'failed', message};
}

/**
 * A SOURCE IN WORDS, for a mismatch an operator has to read: the chain, and each
 * contract with its start block and the events it is indexed for.
 */
function describeSource<ABI extends Abi>(source: IndexingSource<ABI>): string {
	const eventsOf = (abi: Abi): string =>
		abi
			.filter((item) => item.type === 'event')
			.map((item) => (item as {name: string}).name)
			.join(', ');
	const contracts = Array.isArray(source.contracts)
		? (source.contracts as readonly {address: string; abi: Abi; startBlock?: number}[]).map(
				(contract) => `${contract.address} from block ${contract.startBlock ?? 0} (${eventsOf(contract.abi)})`,
			)
		: [
				`every address from block ${(source.contracts as {startBlock?: number}).startBlock ?? 0} ` +
					`(${eventsOf((source.contracts as {abi: Abi}).abi)})`,
			];
	return `chain ${source.chainId}: ${contracts.join('; ')}`;
}

/** Where a configured source came from, in the words an operator configured it with. */
function describeOrigin<ABI extends Abi>(origin: ExplicitSource<ABI>): string {
	return origin.from === 'deployments' ? `--deployments ${origin.folder}` : 'INDEXING_SOURCE';
}
