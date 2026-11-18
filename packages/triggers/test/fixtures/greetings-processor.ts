// COPIED from jolly-roger `with/indexer` c83f2f6e (step F1a),
// `web/src/lib/onchain/indexer/processor.ts`, byte for byte but its ABI's type,
// which there comes from the app's deployments (`$lib/deployments`) and here
// from `./greetings-registry.ts`. It is the fold an `etherfold run` of the
// greetings' processor runs, so a change there is copied here.
/**
 * THE GREETINGS' INDEXER LOGIC: an etherfold `EntityProcessor` folding
 * GreetingsRegistry's `MessageChanged` into how many greetings each account has
 * sent. That number is what a direct read cannot give: the contract keeps each
 * account's LAST greeting, and the count is an aggregate over its history,
 * which is what an indexer is for (the service-layers spec's worked example).
 *
 * This file is the APP's, as every app's indexer logic is its own
 * (`$lib/indexer` hosts it, see `README.indexer.md`); a descendant that drops
 * the greetings drops this folder with them.
 *
 * `MessageChanged(user, message)` is emitted once per `setMessage`, so one
 * event is one greeting. An account is keyed lower-case, as the view compares
 * addresses.
 */
import {
	declareEntities,
	type EntityProcessor,
} from '@etherfold/processor-entities';
import type {GreetingsRegistryABI} from './greetings-registry.js';

export const greetingsEntities = declareEntities([
	/** An account that has greeted, and how many times. */
	{
		name: 'greeter',
		id: 'account',
		fields: {greetings: 'integer'},
	},
]);

export const greetingsProcessor: EntityProcessor<GreetingsRegistryABI> = {
	entities: greetingsEntities,

	async onMessageChanged(state, event) {
		const account = event.args.user.toLowerCase();
		const greeter = (await state.get('greeter', {account})) as
			{greetings: number} | undefined;
		state.set(
			'greeter',
			{account},
			{greetings: Number(greeter?.greetings ?? 0) + 1},
		);
	},
};
