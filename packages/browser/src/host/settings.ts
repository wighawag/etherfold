import type {Abi, IndexingSource, PromotionConfig, ProvidedIndexerConfig} from '@etherfold/core';
import type {BrowserPublicationOptions} from '../publication.js';
import type {BrowserStreamSeedOptions} from '../publishedStart.js';

/**
 * WHAT A TAB MAY TELL ITS HOST WHEN IT CONNECTS: the part of a worker host's spec
 * that is DATA, and so can cross a port.
 *
 * A worker entry holds what is CODE (`createState`, `createProcessor`, a processor
 * module, a `keepStream`), because code cannot be cloned and has to be imported
 * where the fold runs (ADR-0082). What the tab knows at run time and the entry
 * cannot (the chain the user connected, the deployments, where the publication
 * is, how long a catch-up may take) is this, handed over with the connection the
 * way `webevm`'s `createWorkerNode({worker, ...options})` passes its cloneable
 * options: `connectToIndexerHost(access, {provider, settings})`.
 *
 * Every field is under the name the worker spec (`HostedIndexerSpec`) and
 * `createIndexerState` already use for it, so a value moves from the entry to
 * the tab without being renamed. It is CHECKED for cloneability on the tab,
 * naming the field, so a `publication.fetch` or a `config.keepStream` (both
 * functions) is refused where it was written rather than thrown out of
 * `postMessage`. Those stay in the entry.
 *
 * ## One value, one place
 *
 * A setting may be given by the entry OR by a tab, and a host told two different
 * values for it REFUSES the connect, naming the fields (`HostSettingsConflictError`),
 * rather than picking one silently. See `settleHostSettings` for the rule.
 */
export type HostSettings = {
	/** The contracts and events to fold, as `HostedIndexerSpec.source`. */
	readonly source?: IndexingSource<Abi>;
	/** As `HostedIndexerSpec.config`. A `keepStream` in it is code and stays in the entry. */
	readonly config?: ProvidedIndexerConfig<Abi>;
	/** Where the publication index is, as `HostedIndexerSpec.publication`. A `fetch` in it stays in the entry. */
	readonly publication?: BrowserPublicationOptions;
	/** The returning-tab catch-up budget, as `HostedIndexerSpec.catchUpWithinSeconds`. */
	readonly catchUpWithinSeconds?: number | 'always';
	/** A stream seed to install, as `HostedIndexerSpec.seed`. Needs a `keepStream`, which the entry holds. */
	readonly seed?: BrowserStreamSeedOptions;
	/** The promotion policy, as `HostedIndexerSpec.promotion`. */
	readonly promotion?: PromotionConfig;
};

/** The names of every `HostSettings` field, which is the whole list a conflict is checked over. */
export const HOST_SETTING_NAMES = [
	'source',
	'config',
	'publication',
	'catchUpWithinSeconds',
	'seed',
	'promotion',
] as const satisfies readonly (keyof HostSettings)[];

/** One `HostSettings` field name, or `provider`, which is not a setting but is refused the same way. */
export type HostSettingName = (typeof HOST_SETTING_NAMES)[number] | 'provider';

/**
 * A TAB'S CONNECT WAS REFUSED because it disagrees with what the host already has.
 *
 * Carries `fields`, the names that disagreed, so an app branches on them rather
 * than on the sentence. It crosses the port as its name and its fields (see
 * `errors.ts`), which is how a tab reads it.
 *
 * Nothing the refused connect carried was applied: a host told two different
 * values has no rule for choosing, and a merge that took half of a connect would
 * leave neither side knowing what the host is folding.
 */
export class HostSettingsConflictError extends Error {
	readonly fields: readonly HostSettingName[];

	constructor(fields: readonly HostSettingName[], why: string) {
		super(
			`this indexer host refused the tab's connect: ${fields.map((field) => `\`${field}\``).join(', ')} ${why}. ` +
				`A setting is given in ONE place, the worker entry or the tab, and a host that is already folding keeps ` +
				`the settings it started with: change the source with \`reconfigure\`, and anything else by giving it ` +
				`from the tab only.`,
		);
		this.name = 'HostSettingsConflictError';
		this.fields = fields;
	}
}

/**
 * THE SETTINGS A HOST FOLDS WITH, given what it holds and what a tab just sent.
 *
 * The rule, which is the whole of the precedence question:
 *
 * - a setting the tab LEAVES OUT agrees with anything;
 * - BEFORE the host starts, a tab's value fills a setting nobody has given, and
 *   one EQUAL to what is held is accepted; a DIFFERENT one is refused;
 * - ONCE the host has started, its settings are FIXED: a tab's value is accepted
 *   only where it equals the one in force, and a value for a setting the host
 *   started WITHOUT is refused too, because it could not take effect and a tab
 *   that believed it had would be wrong about what it is reading.
 *
 * So neither side WINS, and that is deliberate: the entry and the tab come out of
 * one build, a disagreement between them is a bug in that build, and a silent
 * winner would hide it. Two tabs of one SharedWorker that send the same values
 * (the ordinary case: one app, one build) connect without a word.
 *
 * Returns the merged settings, or throws `HostSettingsConflictError`.
 */
export function settleHostSettings(held: HostSettings, sent: HostSettings, started: boolean): HostSettings {
	const conflicting: HostSettingName[] = [];
	const merged: Record<string, unknown> = {...held};
	for (const name of HOST_SETTING_NAMES) {
		const value = sent[name];
		if (value === undefined) continue;
		const current = held[name];
		if (current === undefined) {
			if (started) conflicting.push(name);
			else merged[name] = value;
			continue;
		}
		if (!sameValue(current, value)) conflicting.push(name);
	}
	if (conflicting.length > 0) {
		throw new HostSettingsConflictError(
			conflicting,
			started
				? `differ from what this host started folding with (or it started without them)`
				: `differ from the value the worker entry, or an earlier tab, already gave`,
		);
	}
	return merged as HostSettings;
}

/** The settings a spec holds, as the same shape a tab sends. */
export function hostSettingsOf(spec: HostSettings): HostSettings {
	const settings: Record<string, unknown> = {};
	for (const name of HOST_SETTING_NAMES) {
		if (spec[name] !== undefined) settings[name] = spec[name];
	}
	return settings as HostSettings;
}

/**
 * STRUCTURAL equality over what crosses a port: plain objects, arrays, primitives
 * (`bigint` included). Anything else (a function, a class instance, which a tab's
 * value cannot be since it was cloned) is equal only to itself, so an entry value
 * holding code never equals a tab's copy of it, which is the refusal it should be.
 */
function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const other = b as unknown[];
		return a.length === other.length && a.every((element, index) => sameValue(element, other[index]));
	}
	const plain = (value: object) => {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	};
	if (!plain(a) || !plain(b)) return false;
	const keysOf = (value: object) =>
		Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined);
	const aKeys = keysOf(a);
	const bKeys = keysOf(b);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every(
		(key) =>
			Object.prototype.hasOwnProperty.call(b, key) &&
			sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
	);
}
