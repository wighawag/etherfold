import {decodeFieldValues, fieldStorage, type NormalizedEntity} from '@etherfold/state-store';

/**
 * A stored row as the accessor answers it, on every backend: the declared id
 * columns and fields only (never a version column, nor any column a backend
 * added to plan its read), an absent field as `null`, a `blob` as a
 * `Uint8Array` whatever wrapper the driver handed back, and each semantic field
 * decoded from its canonical encoding (a `u256` to a `bigint`, ADR-0098).
 */
export function answeredRow(entity: NormalizedEntity, stored: Record<string, unknown>): Record<string, unknown> {
	const row: Record<string, unknown> = {};
	for (const column of entity.id) row[column] = stored[column];
	for (const [field, declared] of Object.entries(entity.fields)) {
		const value = stored[field] ?? null;
		row[field] = fieldStorage(declared) === 'blob' && value !== null ? asBytes(value) : value;
	}
	return decodeFieldValues(entity, row);
}

function asBytes(value: unknown): unknown {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	return value;
}
