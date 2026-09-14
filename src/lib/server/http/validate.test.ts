import { describe, it, expect } from 'vitest';
import { pickStrings } from './validate';

describe('pickStrings', () => {
	it('extracts all requested string fields', () => {
		const result = pickStrings({ a: 'x', b: 'y', extra: 123 }, ['a', 'b']);
		expect(result).toEqual({ a: 'x', b: 'y' });
	});

	it('returns null when body is null', () => {
		expect(pickStrings(null, ['a'])).toBeNull();
	});

	it('returns null when body is not an object (e.g. a string)', () => {
		expect(pickStrings('not-an-object', ['a'])).toBeNull();
	});

	it('rejects a string body even when requested keys look like its numeric indices', () => {
		// Isolates the `typeof body !== 'object'` guard: a JS string's indexed
		// access (e.g. "ab"[0] === "a") returns real strings, so if this guard
		// were skipped, the property-type loop below would be fooled into
		// treating a bare string as a valid record.
		expect(pickStrings('ab', ['0', '1'])).toBeNull();
	});

	it('returns null when body is not an object (e.g. a number)', () => {
		expect(pickStrings(42, ['a'])).toBeNull();
	});

	it('returns null when a requested key is missing', () => {
		expect(pickStrings({ a: 'x' }, ['a', 'b'])).toBeNull();
	});

	it('returns null when a requested key has the wrong type', () => {
		expect(pickStrings({ a: 'x', b: 123 }, ['a', 'b'])).toBeNull();
	});

	it('returns an empty object when keys is empty', () => {
		expect(pickStrings({ a: 'x' }, [])).toEqual({});
	});

	it('treats an array body as a non-matching object (missing named keys)', () => {
		expect(pickStrings(['x', 'y'], ['a'])).toBeNull();
	});
});
