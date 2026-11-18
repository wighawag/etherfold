import type {DecodedLog} from './triggers.js';

// ---------------------------------------------------------------------------
// THE STATE READ: what a predicate asks of the indexer's state AS OF the log's
// block (etherfold ADR-0011), over the same `/graphql` an app reads (etherfold
// ADR-0099), pinned by the block's HASH.
// ---------------------------------------------------------------------------
// An event often carries less than a rule needs: GreetingsRegistry's
// `MessageChanged(user, message)` has no count, so "an account's third
// greeting" is a question for the fold's state, not for the log. Pinned by
// hash, so a block that is not the one the log was in (another branch) is
// refused rather than answered. The state is as of the END of the block: two
// logs of one block both see what the fold made of the whole block, which a
// level-triggered rule (a predicate, a semantic key) is indifferent to.
//
// A read that cannot answer THROWS: a predicate then fails, the page is not
// committed, and the consumer reads it again next round. It is never taken for
// "the rule does not fire", which would drop the trigger silently.
// ---------------------------------------------------------------------------

/** Why a read did not answer: a GraphQL error's code (`block-not-recorded`, `block-not-retained`, ...), `http-<status>`, or `no-answer`. */
export class StateReadError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = 'StateReadError';
	}
}

export type StateReader = {
	/**
	 * Run a GraphQL document as of a block: a log's (its `entry.blockHash`) or a
	 * `{blockHash}`. The document declares `$block: BlockAddress!` and passes it
	 * to each root field (`greeter(..., block: $block)`); `variables` are the
	 * others. Answers the `data`, or throws a `StateReadError`.
	 */
	query<T = Record<string, unknown>>(
		document: string,
		at: DecodedLog | {blockHash: string},
		variables?: Record<string, unknown>,
	): Promise<T>;
};

type GraphQLAnswer = {
	data?: unknown;
	errors?: {message: string; extensions?: {code?: unknown}}[];
};

/**
 * A `StateReader` over an etherfold server's `/graphql` (`etherfold run` or
 * `etherfold serve`, the one the consumer follows). `url` is its base, as the
 * feed's. The server must retain the history the consumer reads at: the safe
 * lane acts on blocks at finality, so a `--retention revert-only` indexer has
 * pruned them and answers `block-not-retained` (etherfold's default retention,
 * `unbounded`, keeps them).
 */
export function stateReader(options: {url: string; fetch?: typeof fetch}): StateReader {
	const endpoint = `${options.url.replace(/\/+$/, '')}/graphql`;
	const doFetch = options.fetch ?? fetch;
	return {
		async query<T>(document: string, at: DecodedLog | {blockHash: string}, variables: Record<string, unknown> = {}) {
			const hash = 'entry' in at ? at.entry.blockHash : at.blockHash;
			let response: Response;
			try {
				response = await doFetch(endpoint, {
					method: 'POST',
					headers: {'Content-Type': 'application/json', Accept: 'application/json'},
					body: JSON.stringify({query: document, variables: {...variables, block: {hash}}}),
				});
			} catch (error) {
				throw new StateReadError(
					`the state was not read: ${error instanceof Error ? error.message : String(error)}`,
					'no-answer',
				);
			}
			const text = await response.text();
			if (!response.ok) {
				throw new StateReadError(
					`the state was not read (${response.status}): ${text.slice(0, 200)}`,
					`http-${response.status}`,
				);
			}
			let answer: GraphQLAnswer;
			try {
				answer = JSON.parse(text) as GraphQLAnswer;
			} catch {
				throw new StateReadError(`the state was not read: the answer is not JSON`, 'invalid-answer');
			}
			const first = answer.errors?.[0];
			if (first) {
				const code = typeof first.extensions?.code === 'string' ? first.extensions.code : 'graphql-error';
				throw new StateReadError(`the state as of ${hash} was refused: ${first.message}`, code);
			}
			if (answer.data === undefined || answer.data === null) {
				throw new StateReadError(`the state as of ${hash} answered no data`, 'invalid-answer');
			}
			return answer.data as T;
		},
	};
}
