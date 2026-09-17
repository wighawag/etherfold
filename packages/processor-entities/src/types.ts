import type {
	Abi,
	AbiEvent,
	AbiParameterToPrimitiveType,
	ExtractAbiEvent,
	ExtractAbiEventNames,
	LogEvent,
	LogEventWithParsingFailure,
} from '@etherfold/core';
import type {EntityDeclaration, MutationContext} from '@etherfold/state-store';

export type InputNames<T extends AbiEvent> = Extract<T['inputs'][number], {name: string}>['name'];

/**
 * The named inputs of an event, as a UNION when `T` is one.
 *
 * The conditional is not decoration: it makes the mapped type DISTRIBUTE. An
 * upgraded contract can carry two events under one name
 * (`Transfer(address,address,uint256)` then
 * `Transfer(address,address,uint256,bytes)`), and `ExtractAbiEvent` hands both
 * of them over as a union, because a handler is keyed by NAME. Mapped without
 * distributing, the two input lists MERGED into `{from, to, id, memo}` with
 * `memo` REQUIRED -- so a pre-upgrade log handed the author `undefined` through
 * a type promising a value. Distributed, `args` is a union the author narrows
 * (`'memo' in event.args`) before reading a field only one version has.
 *
 * The single-version case is unchanged: distributing over a non-union is the
 * mapped type itself. Pinned both ways in `test/handler-args.test.ts`, under
 * `pnpm typecheck`. There used to be a second copy of this type in the free-form
 * processor package that had to be kept in step; that package is gone (ADR-0037)
 * and this is now the only one.
 */
export type InputValues<T extends AbiEvent> = T extends AbiEvent
	? {[Property in InputNames<T>]: AbiParameterToPrimitiveType<Extract<T['inputs'][number], {name: Property}>>}
	: never;

/** `on<EventName>` handlers, typed off the ABI. */
export type EventHandlers<ABI extends Abi, ProcessorConfig = undefined> = {
	[Property in ExtractAbiEventNames<ABI> as `on${Property}`]?: (
		state: MutationContext,
		event: LogEvent<ABI> & {args: InputValues<ExtractAbiEvent<ABI, Property>>},
		config: ProcessorConfig,
	) => Promise<void> | void;
};

/**
 * What an author writes: the entity schema, and a handler per event.
 *
 * The shape deliberately kept the retired free-form `JSProcessor`'s, so that
 * moving a processor from an in-memory object to versioned rows was a change of
 * write calls and nothing else. `construct()` has no counterpart here: the
 * initial state of a versioned store is an empty set of entities, which
 * `migrate` creates from `entities`.
 *
 * Nothing in this type names a backend, and that is its whole point. The same
 * object runs against `@etherfold/state-store-sqlite` on a server and against
 * any other `StateStore` in a browser; where the state lives is a deployment
 * choice the processor neither sees nor encodes.
 */
export type EntityProcessor<ABI extends Abi, ProcessorConfig = undefined> = EventHandlers<ABI, ProcessorConfig> & {
	/**
	 * REQUIRED, and SUPERSEDED: the author's own declaration of which fold this is.
	 *
	 * ADR-0086 moves identity off the author and onto the ARRIVAL -- a processor IS a
	 * bundle and the hash of its bytes IS its name -- precisely because this field
	 * could be forgotten, and a forgotten bump means state computed by the previous
	 * logic served for ever and silently. So do not reach for it in new code: a host
	 * that has an identity hands it over (`EntityEventProcessorOptions.identity`) and
	 * the declaration is not consulted at all.
	 *
	 * It is still REQUIRED and still WORKS, because it is what identifies a fold whose
	 * arrival had no bytes to hash, and `the-declared-version-and-the-drift-report-are-deleted`
	 * is what removes it. On that path: the indexer discards state computed by a
	 * previous version by comparing `getVersionHash()`, of which this is the declared
	 * part. The entity declarations are hashed in alongside it, so a SCHEMA change
	 * invalidates without a bump; handlers are functions, not data, so a HANDLER
	 * change does not, and the advisory code fingerprint is what says so.
	 */
	version: string;
	/** `{name, id, fields}` per entity: the store owns the versions, the layout and the revert. */
	entities: readonly EntityDeclaration[];
	handleUnparsedEvent?(state: MutationContext, event: LogEventWithParsingFailure): void | Promise<void>;
};
