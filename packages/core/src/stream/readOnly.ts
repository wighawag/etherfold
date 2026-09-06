import type {Abi} from 'abitype';
import type {ExistingStream, StreamFetcher, UsedStreamConfig} from '../types.js';

/**
 * The READ half of the stream seam, alone: everything a pure reader needs and
 * nothing it must not have.
 *
 * `setStreamConfig` is here because it is not a write to the STREAM, it is the
 * other half of the stream's IDENTITY (`ExistingStream.setStreamConfig`): a
 * keeper that ADDRESSES a stream has to be told which one, and a reader that
 * swallowed it would read a different subtree from the one it was pointed at.
 * A reader that addresses nothing -- one holding exactly ONE stream, which it
 * serves whatever it is asked for -- has no use for it, which is why it stays
 * optional.
 */
export type StreamReader<ABI extends Abi> = {
	fetchFrom: StreamFetcher<ABI>;
	setStreamConfig?: (streamConfig: UsedStreamConfig) => void;
};

/**
 * A STREAM YOU CAN ONLY READ: an `ExistingStream` whose `saveNewEvents` and
 * `clear` are no-ops.
 *
 * ## Why this has to exist at all
 *
 * READ and WRITE share ONE seam. A generation handed the stream to fold is
 * handed the thing that also appends, and `promiseToSave` calls `saveNewEvents`
 * UNCONDITIONALLY -- so "a generation that merely reads" is not something a
 * caller can express by declining to write, and it is not something a
 * CONFIGURATION could express either, because the save is driven by the indexing
 * loop rather than by the caller's intent. It is expressed by handing over a
 * stream whose writes go nowhere.
 *
 * That is what makes the ONE-WRITER RULE structural: only the generation that
 * INDEXES a stream is given the keeper, every other generation folding it is
 * given one of these, and a second writer is therefore unreachable rather than
 * merely discouraged.
 *
 * ## Why the writes are NO-OPS and not refusals
 *
 * A throw would wedge the engine, and correctly so: it does not process a batch
 * it could not write (`StreamWriteOutcome`), so a refusing keeper would freeze
 * the fold rather than leave it read-only. Silence is the honest answer here --
 * there is nothing to write, because somebody else already wrote it.
 *
 * `clear` is a no-op for a sharper reason than symmetry: the load path clears
 * the cached stream on every shape it cannot use (a stream that does not match
 * the source, a stream that will not re-parse, a stream that does not reach back
 * far enough), and a follower takes those branches over a stream ANOTHER
 * generation is still indexing into. A view that passed `clear` through would
 * delete the live generation's history from underneath it.
 *
 * ## One view, over KEEPERS
 *
 * What this wraps is always a keeper of the stream, so that there is ONE
 * definition of what read-only means on this seam rather than several that can
 * drift apart: a follower is handed one over the keeper the writing generation
 * owns (`container.ts`), and `storedEmissionStream` (`@etherfold/server`) is one
 * over the emission table read back.
 *
 * NOT a caller: `replayStream`, a captured fixture. It was built out of this
 * until the keeper seam narrowed to what the NODE said, which a fixture's
 * deliberately DECODED events are not; it now has its own reader type with no
 * write half at all (`fixture.ts`, ADR-0059). That is a fixture leaving this
 * seam rather than a second read-only implementation of it -- the rule below is
 * untouched.
 *
 * The rule this serves, and the options weighed against it, are ADR-0044.
 */
export function readOnlyStream<ABI extends Abi>(reader: StreamReader<ABI>): ExistingStream<ABI> {
	const setStreamConfig = reader.setStreamConfig?.bind(reader);
	return {
		fetchFrom: (source, fromBlock) => reader.fetchFrom(source, fromBlock),
		saveNewEvents: async () => {
			// somebody else owns this stream; a reader appends nothing to it
		},
		clear: async () => {
			// nothing here is ours to delete
		},
		...(setStreamConfig ? {setStreamConfig} : {}),
	};
}
