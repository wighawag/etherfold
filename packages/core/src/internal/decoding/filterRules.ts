import type {AbiEvent} from 'abitype';
import type {ArgumentFilter, FilterRule} from '../../types.js';
import type {ExtraFilters} from '../engine/ethereum.js';
import {deepEqual} from '../utils/compare.js';
import {normalizeAddress} from '../utils/address.js';
import {canonicalSignatureOf, decodingShapeOf, describeEventDeclaration, topic0Of} from './eventIdentity.js';

/**
 * ONE event declaration as the source presents it: at an ADDRESS, or at none on
 * the single merged `{abi}` form.
 */
export type SourceDeclaration = {
	/** `null` on an address-less source, where there is nothing to scope by. */
	address: `0x${string}` | null;
	event: AbiEvent;
};

/** A `FilterRule.event` is read as a SIGNATURE if and only if it contains `(`. */
function isSignature(event: string): boolean {
	return event.indexOf('(') !== -1;
}

/** The NAME half of whatever was written in `event`, signature or not. */
function nameOf(event: string): string {
	const open = event.indexOf('(');
	return open === -1 ? event : event.slice(0, open);
}

function refuse(message: string): never {
	throw new Error(`invalid argument filter: ${message}`);
}

function quotedList(values: readonly string[]): string {
	return values.length === 0 ? '(none)' : values.map((value) => `\`${value}\``).join(', ');
}

function uniqueInOrder<T>(values: readonly T[]): T[] {
	const seen = new Set<T>();
	const out: T[] = [];
	for (const value of values) {
		if (!seen.has(value)) {
			seen.add(value);
			out.push(value);
		}
	}
	return out;
}

/** How many INDEXED arguments a declaration has, which is how deep a `match` entry may go. */
function indexedArgumentCount(event: AbiEvent): number {
	return event.inputs.filter((input) => input.indexed).length;
}

/**
 * TURN THE AUTHORED RULES INTO WHAT THE REQUEST PLANNER TAKES, refusing at
 * construction anything the planner could only answer with a quiet nothing.
 *
 * A filter restricts a (contract, `topic0`) pair and never a `topic0`, so this
 * produces two kinds of instruction per `topic0` a rule reaches: the SCOPED
 * requests (one per `match` entry, at the rule's addresses) and the LEFTOVER
 * (that `topic0`, unfiltered, at the addresses no rule reached). A `topic0` no
 * rule mentions gets no instruction at all, which the planner reads as
 * unscoped -- an address nobody filtered is not filtered. See ADR-0062.
 *
 * ## Why every one of these is a REFUSAL
 *
 * The two alternatives are both silent. Widening (ignore the part of the rule
 * that does not fit) hands back a stream carrying more than the caller asked
 * for; narrowing (drop the part that does not fit) unrequests logs, and
 * afterwards nothing distinguishes "the chain had none" from "we never asked",
 * which is the failure class ADR-0031 exists to prevent. A refusal at
 * construction cannot be mistaken for either, and every message below names
 * what to change.
 */
export function resolveFilterRules(
	rules: readonly FilterRule[],
	declarations: readonly SourceDeclaration[],
): ExtraFilters {
	const addressLess = declarations.every((declaration) => declaration.address === null);
	// what IS declared, for the refusal messages: names in declaration order, and
	// the canonical signatures each name covers
	const declaredNames = uniqueInOrder(declarations.map((declaration) => declaration.event.name));
	const signaturesOfName = (name: string) =>
		uniqueInOrder(
			declarations
				.filter((declaration) => declaration.event.name === name && !declaration.event.anonymous)
				.map((declaration) => canonicalSignatureOf(declaration.event)),
		);

	/** Which addresses declare a `topic0`, in source order. `null` on an address-less source. */
	const declaringAddressesOf = (topic0: `0x${string}`): `0x${string}`[] | null =>
		addressLess
			? null
			: uniqueInOrder(
					declarations
						.filter((declaration) => topic0Of(declaration.event) === topic0 && declaration.address !== null)
						.map((declaration) => declaration.address as `0x${string}`),
				);

	const resolved: ExtraFilters = [];
	/** Per `topic0` a rule reached: the addresses those rules covered. */
	const coveredPerTopic0 = new Map<`0x${string}`, Set<`0x${string}`>>();
	const reachedTopic0s: `0x${string}`[] = [];

	for (const rule of rules) {
		const named = `\`${rule.event}\``;

		// R5: a rule that constrains nothing is not a filter, and the two ways of
		// writing one differ from "no rule here" only in intent.
		if (!Array.isArray(rule.match) || rule.match.length === 0) {
			refuse(
				`the rule for ${named} has an empty \`match\`, so it constrains nothing. ` +
					`Give it at least one entry, or delete the rule if that event should not be filtered.`,
			);
		}
		for (const entry of rule.match) {
			if (entry.length === 0 || entry.every((slot) => slot === null)) {
				refuse(
					`the rule for ${named} has a \`match\` entry that constrains nothing ` +
						`(${entry.length === 0 ? 'it is empty' : 'every slot is the null wildcard'}). ` +
						`Constrain at least one slot, or delete the entry.`,
				);
			}
		}

		// R6: there is no address to scope by on the single merged `{abi}` form.
		if (rule.contracts && addressLess) {
			refuse(
				`the rule for ${named} sets \`contracts\`, but this source declares ONE merged ABI and no addresses, ` +
					`so there is no address to scope by. Drop \`contracts\`, or declare the source as a list of ` +
					`\`{address, abi}\` contracts.`,
			);
		}

		// R8 is folded into R1: an ANONYMOUS declaration carries no `topic0`, so it
		// can be neither requested nor filtered, and it is ignored here rather than
		// producing a rule that cannot be expressed.
		const wanted = isSignature(rule.event)
			? (declaration: SourceDeclaration) =>
					!declaration.event.anonymous && canonicalSignatureOf(declaration.event) === rule.event
			: (declaration: SourceDeclaration) => !declaration.event.anonymous && declaration.event.name === rule.event;
		const candidates = declarations.filter(wanted);

		if (candidates.length === 0) {
			const name = nameOf(rule.event);
			const available = signaturesOfName(name);
			if (isSignature(rule.event)) {
				// R7: a near miss on a signature. The comparison is byte equality against
				// viem's canonical form, so this is where a space or a `uint` alias lands.
				refuse(
					`the rule targets the signature ${named}, which is not byte-equal to any canonical signature this ` +
						`source declares. ${
							available.length > 0
								? `Declared for \`${name}\`: ${quotedList(available)}.`
								: `This source declares no event named \`${name}\` at all. Declared events: ${quotedList(declaredNames)}.`
						} The comparison is strict: no spaces, and no aliases (write \`uint256\`, never \`uint\`).`,
				);
			}
			const anonymousOnly = declarations.some(
				(declaration) => declaration.event.name === rule.event && declaration.event.anonymous,
			);
			// R1 (and R8 arriving at it): name it, and list what IS declared.
			refuse(
				anonymousOnly
					? `the rule targets ${named}, which this source declares ONLY as an anonymous event. An anonymous ` +
							`event carries no topic0 -- its \`topics[0]\` is an indexed argument -- so it can be neither ` +
							`requested by selector nor filtered. Filter a non-anonymous event instead: ` +
							`${quotedList(declaredNames.filter((declared) => signaturesOfName(declared).length > 0))}.`
					: `the rule targets ${named}, which this source declares no event by. ` +
							`Declared events: ${quotedList(declaredNames)}. Name one of those, or one of their canonical ` +
							`signatures (for example ${quotedList(signaturesOfName(declaredNames[0]).slice(0, 1))}).`,
			);
		}

		// R2: an address named in `contracts` that declares nothing matching is a
		// typo or a stale address, and silently ignoring it scopes the rule
		// somewhere the author did not mean.
		const scopeAddresses = rule.contracts ? rule.contracts.map((address) => normalizeAddress(address)) : undefined;
		if (scopeAddresses) {
			const declaringHere = new Set(
				candidates.map((candidate) => candidate.address).filter((address): address is `0x${string}` => !!address),
			);
			for (const address of scopeAddresses) {
				if (!declaringHere.has(address)) {
					refuse(
						`the rule for ${named} names contract \`${address}\` in \`contracts\`, and that contract declares no ` +
							`matching event. Remove it, or name one of the contracts that do declare it: ` +
							`${quotedList([...declaringHere])}.`,
					);
				}
			}
		}

		const scoped = scopeAddresses
			? candidates.filter((candidate) => candidate.address !== null && scopeAddresses.indexOf(candidate.address) !== -1)
			: candidates;

		const topic0sOfRule = uniqueInOrder(
			scoped.map((candidate) => topic0Of(candidate.event) as `0x${string}`).filter((topic0) => !!topic0),
		);

		for (const topic0 of topic0sOfRule) {
			const here = scoped.filter((candidate) => topic0Of(candidate.event) === topic0);

			// R3: the ADR-0061 tolerated collision meeting a filter. Two decoding
			// shapes under one topic0 make a POSITIONAL filter mean two different
			// things, and the remedy is to say which one is meant.
			const shapes: {shape: unknown; event: AbiEvent; addresses: `0x${string}`[]}[] = [];
			for (const candidate of here) {
				const shape = decodingShapeOf(candidate.event);
				const seen = shapes.find((entry) => deepEqual(entry.shape, shape));
				if (seen) {
					if (candidate.address && seen.addresses.indexOf(candidate.address) === -1) {
						seen.addresses.push(candidate.address);
					}
				} else {
					shapes.push({shape, event: candidate.event, addresses: candidate.address ? [candidate.address] : []});
				}
			}
			if (shapes.length > 1) {
				refuse(
					`the rule for ${named} reaches topic0 ${topic0}, which ${shapes.length} different decoding shapes ` +
						`answer to in this source: ` +
						shapes
							.map((entry) => `\`${describeEventDeclaration(entry.event)}\` at ${quotedList(entry.addresses)}`)
							.join(', and ') +
						`. A positional argument filter means a different thing at each of them (an ERC-721 \`Transfer\` ` +
						`indexes three arguments and an ERC-20 one indexes two). Add \`contracts\` to scope this rule to ` +
						`one of them.`,
				);
			}

			// R4: deeper than the shape indexes, so the request provably matches
			// nothing. Refused rather than trimmed, because trimming would WIDEN what
			// the caller asked for.
			const indexed = indexedArgumentCount(shapes[0].event);
			for (const entry of rule.match) {
				if (entry.length > indexed) {
					refuse(
						`the rule for ${named} constrains ${entry.length} indexed argument${entry.length === 1 ? '' : 's'}, ` +
							`but \`${canonicalSignatureOf(shapes[0].event)}\` indexes only ${indexed}. A \`topics[${entry.length}]\` ` +
							`constraint provably matches no log of it. Shorten the entry to at most ${indexed} slot${
								indexed === 1 ? '' : 's'
							}, using \`null\` to leave one unconstrained.`,
					);
				}
			}

			const requestScope = addressLess
				? null
				: uniqueInOrder(here.map((candidate) => candidate.address as `0x${string}`));
			for (const entry of rule.match) {
				resolved.push({
					kind: 'match',
					topic0,
					contractAddresses: requestScope,
					match: entry as ArgumentFilter,
				});
			}

			if (!reachedTopic0s.includes(topic0)) {
				reachedTopic0s.push(topic0);
			}
			let covered = coveredPerTopic0.get(topic0);
			if (!covered) {
				covered = new Set();
				coveredPerTopic0.set(topic0, covered);
			}
			for (const address of requestScope || []) {
				covered.add(address);
			}
		}
	}

	// THE LEFTOVER: what a rule reached but did not COVER. An address that
	// declares this topic0 and that no rule named is still asked for, unfiltered.
	for (const topic0 of reachedTopic0s) {
		const declaring = declaringAddressesOf(topic0);
		if (declaring === null) {
			// address-less source: a rule reaching the topic0 reaches all there is of it
			continue;
		}
		const covered = coveredPerTopic0.get(topic0) as Set<`0x${string}`>;
		const leftover = declaring.filter((address) => !covered.has(address));
		if (leftover.length > 0) {
			resolved.push({kind: 'leftover', topic0, contractAddresses: leftover});
		}
	}

	return resolved;
}
