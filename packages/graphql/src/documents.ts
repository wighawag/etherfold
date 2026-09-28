import {GraphQLError, parse, validate, type DocumentNode, type GraphQLSchema} from 'graphql';

/**
 * PARSED AND VALIDATED DOCUMENTS, kept so a repeated query is not parsed and
 * validated again (ADR-0099, story 25).
 *
 * In a browser worker there is no network to hide behind: an app re-asks the
 * same handful of documents on every state-moved signal, and `parse` plus
 * `validate` would otherwise be the hot path of every answer. So the worker
 * handler (`graphqlQueryHandler` in `@etherfold/graphql/worker`) holds one of
 * these, and any other host may pass one to `executeQuery`.
 *
 * Keyed by the SCHEMA and the document text, because validation is against a
 * schema: a promotion to a generation with other declarations builds another
 * schema, and a document valid against one is not thereby valid against the
 * other. Bounded (least recently used goes first), because the text is the
 * key and a client that inlines its variables would otherwise grow it without
 * end. A document that does not parse or validate is kept too, with its errors,
 * so a repeated bad query is refused as cheaply as a good one is answered.
 */
export class DocumentCache {
	/** How many documents are kept per schema. */
	readonly max: number;
	/** How many times a document was actually PARSED: a hit does not count. */
	get parsed(): number {
		return this.parses;
	}

	private parses = 0;
	private readonly bySchema = new WeakMap<GraphQLSchema, Map<string, PreparedDocument>>();

	constructor(options: {readonly max?: number} = {}) {
		const max = options.max ?? DEFAULT_DOCUMENT_CACHE_SIZE;
		if (!Number.isInteger(max) || max < 1) {
			throw new Error(`a document cache keeps a whole number of documents, at least 1, got ${String(max)}`);
		}
		this.max = max;
	}

	/** The document for `query`, parsed and validated against `schema`, or the errors that refused it. */
	prepare(schema: GraphQLSchema, query: string): PreparedDocument {
		let documents = this.bySchema.get(schema);
		if (!documents) {
			documents = new Map();
			this.bySchema.set(schema, documents);
		}
		const held = documents.get(query);
		if (held) {
			// most recently used goes last, so the first key is the one to evict
			documents.delete(query);
			documents.set(query, held);
			return held;
		}
		this.parses++;
		const prepared = prepareDocument(schema, query);
		documents.set(query, prepared);
		if (documents.size > this.max) documents.delete(documents.keys().next().value!);
		return prepared;
	}
}

/** How many documents a `DocumentCache` keeps per schema unless told otherwise. */
export const DEFAULT_DOCUMENT_CACHE_SIZE = 100;

/** A document ready to execute, or the errors that refused it before anything was read. */
export type PreparedDocument =
	| {readonly document: DocumentNode; readonly errors?: undefined}
	| {readonly document?: undefined; readonly errors: readonly GraphQLError[]};

/** Parse and validate once, with no cache. */
export function prepareDocument(schema: GraphQLSchema, query: string): PreparedDocument {
	let document: DocumentNode;
	try {
		document = parse(query);
	} catch (error) {
		if (error instanceof GraphQLError) return {errors: [error]};
		return {errors: [new GraphQLError(String((error as Error)?.message ?? error))]};
	}
	const invalid = validate(schema, document);
	if (invalid.length > 0) return {errors: invalid};
	return {document};
}
