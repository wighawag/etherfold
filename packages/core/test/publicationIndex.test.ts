import {describe, expect, it} from 'vitest';
import {isPublicationIndex, publishedBodyLocation, PUBLICATION_INDEX_FORMAT} from '../src/index.js';

/**
 * THE PUBLICATION INDEX DOCUMENT (ADR-0095), as both of its sides read it: the
 * producer refuses to rewrite what `isPublicationIndex` rejects, and a tab refuses
 * to read it; and a body is named RELATIVE to its index, wherever that is served.
 */
describe('the publication index document', () => {
	it('is recognised by its format and its maps, and nothing else', () => {
		expect(isPublicationIndex({format: PUBLICATION_INDEX_FORMAT, snapshots: {}})).toBe(true);
		expect(isPublicationIndex({format: PUBLICATION_INDEX_FORMAT, snapshots: {}, seeds: {}})).toBe(true);
		// keys it does not know are the producer's to carry, not a reason to refuse
		expect(isPublicationIndex({format: PUBLICATION_INDEX_FORMAT, snapshots: {}, later: 1})).toBe(true);

		expect(isPublicationIndex({format: PUBLICATION_INDEX_FORMAT + 1, snapshots: {}})).toBe(false);
		expect(isPublicationIndex({format: PUBLICATION_INDEX_FORMAT})).toBe(false);
		expect(isPublicationIndex({format: PUBLICATION_INDEX_FORMAT, snapshots: []})).toBe(false);
		expect(isPublicationIndex({format: PUBLICATION_INDEX_FORMAT, snapshots: {}, seeds: null})).toBe(false);
		expect(isPublicationIndex([])).toBe(false);
		expect(isPublicationIndex(undefined)).toBe(false);
	});

	it('names a body relative to the index, on a host or at a hostless, build-embedded path', () => {
		expect(publishedBodyLocation('https://cdn.example/app/publication.json', 'state-ab.ndjson.gz')).toBe(
			'https://cdn.example/app/state-ab.ndjson.gz',
		);
		expect(publishedBodyLocation('https://cdn.example/app/publication.json?v=3', 'state-ab.ndjson.gz')).toBe(
			'https://cdn.example/app/state-ab.ndjson.gz',
		);
		expect(publishedBodyLocation('/indexed-states/publication.json', 'seed-cd.json.gz')).toBe(
			'/indexed-states/seed-cd.json.gz',
		);
		expect(publishedBodyLocation('./publication.json#x', 'seed-cd.json.gz')).toBe('./seed-cd.json.gz');
		expect(publishedBodyLocation('publication.json', 'seed-cd.json.gz')).toBe('seed-cd.json.gz');
	});
});
