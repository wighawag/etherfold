import type {EntityProcessor} from '@etherfold/processor-entities';
import type {TestABI} from '../../../browser/workload.js';

/**
 * THE ENTRY A PUBLISHED BUNDLE IS BUILT FROM, in the shape an app's own processor
 * entry has: a module exporting `createProcessor`, which `etherfold build` calls
 * with no arguments and a tab running the published bundle calls the same way.
 *
 * It is the workload's processor (`browser/workload.ts`), written out again rather
 * than imported, and that is deliberate: a bundle is SELF-CONTAINED, and importing
 * the workload module would pull the whole package (and IndexedDB) into the
 * bundle. The imports above are TYPES, which esbuild erases, so the bundle carries
 * nothing but this fold. The suite checks the fold agrees with the workload's
 * `EXPECTED_A`, so a drift between the two copies is a red test, not a silent one.
 */
export function createProcessor(): EntityProcessor<TestABI> {
	return {
		entities: [
			{name: 'token', id: ['id'], fields: {owner: 'text'}},
			{name: 'counter', id: ['name'], fields: {value: 'integer'}},
		],
		async onTransfer(state, event) {
			state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
			const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
			state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
		},
	};
}
