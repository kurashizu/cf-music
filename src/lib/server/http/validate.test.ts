import { describe, it, expect } from 'vitest';
import { pickStrings, isStringArray, pickStringArray, pickPositiveNumber } from './validate';

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

describe('isStringArray', () => {
	it('returns true for an array of strings', () => {
		expect(isStringArray(['a', 'b', 'c'])).toBe(true);
	});

	it('returns true for an empty array', () => {
		expect(isStringArray([])).toBe(true);
	});

	it('returns false for an array containing a non-string element', () => {
		expect(isStringArray(['a', 1, 'c'])).toBe(false);
	});

	it('returns false for a non-array value', () => {
		expect(isStringArray('not-an-array')).toBe(false);
	});

	it('returns false for null', () => {
		expect(isStringArray(null)).toBe(false);
	});
});

describe('pickStringArray', () => {
	it('extracts a named array-of-strings field', () => {
		expect(pickStringArray({ ids: ['a', 'b'] }, 'ids')).toEqual(['a', 'b']);
	});

	it('returns null when body is not an object', () => {
		expect(pickStringArray('not-an-object', 'ids')).toBeNull();
	});

	it('rejects a non-object body even when it happens to carry a matching array-valued property', () => {
		// Isolates the outer `typeof body !== 'object'` guard: functions are
		// `typeof 'function'` (not 'object') yet can carry arbitrary own
		// properties. If the guard were skipped, indexing into this function
		// by `key` would find a genuine string array and incorrectly succeed.
		const bodyLikeAFunction = Object.assign(() => {}, { ids: ['a', 'b'] });
		expect(pickStringArray(bodyLikeAFunction, 'ids')).toBeNull();
	});

	it('returns null when body is null', () => {
		expect(pickStringArray(null, 'ids')).toBeNull();
	});

	it('returns null when the named field is missing', () => {
		expect(pickStringArray({}, 'ids')).toBeNull();
	});

	it('returns null when the named field is not an array of strings', () => {
		expect(pickStringArray({ ids: [1, 2] }, 'ids')).toBeNull();
	});
});

describe('pickPositiveNumber', () => {
	it('extracts a positive number field', () => {
		expect(pickPositiveNumber({ n: 42 }, 'n')).toBe(42);
	});

	it('returns null for zero (not strictly positive)', () => {
		expect(pickPositiveNumber({ n: 0 }, 'n')).toBeNull();
	});

	it('returns null for a negative number', () => {
		expect(pickPositiveNumber({ n: -5 }, 'n')).toBeNull();
	});

	it('returns null for NaN', () => {
		expect(pickPositiveNumber({ n: NaN }, 'n')).toBeNull();
	});

	it('returns null for Infinity', () => {
		expect(pickPositiveNumber({ n: Infinity }, 'n')).toBeNull();
	});

	it('returns null when the field is a numeric string, not a number', () => {
		expect(pickPositiveNumber({ n: '42' }, 'n')).toBeNull();
	});

	it('returns null when body is not an object', () => {
		expect(pickPositiveNumber('not-an-object', 'n')).toBeNull();
	});

	it('rejects a non-object body even when it happens to carry a matching positive-number property', () => {
		// Isolates the outer `typeof body !== 'object'` guard, same as the
		// pickStringArray case: functions are typeof 'function', not
		// 'object', yet can carry arbitrary own properties.
		const bodyLikeAFunction = Object.assign(() => {}, { n: 42 });
		expect(pickPositiveNumber(bodyLikeAFunction, 'n')).toBeNull();
	});

	it('returns null when body is null', () => {
		expect(pickPositiveNumber(null, 'n')).toBeNull();
	});

	it('returns null when the field is missing', () => {
		expect(pickPositiveNumber({}, 'n')).toBeNull();
	});
});
