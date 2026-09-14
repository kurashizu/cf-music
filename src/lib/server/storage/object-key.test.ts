import { describe, it, expect } from 'vitest';
import { encodeObjectKey } from './object-key';

describe('encodeObjectKey', () => {
	it('leaves a simple alphanumeric key unchanged', () => {
		expect(encodeObjectKey('abc123')).toBe('abc123');
	});

	it('preserves the "/" path separator between segments', () => {
		expect(encodeObjectKey('audio/abc123.webm')).toBe('audio/abc123.webm');
	});

	it('percent-encodes special characters within a segment', () => {
		expect(encodeObjectKey('covers/some file.avif')).toBe('covers/some%20file.avif');
	});

	it('encodes each path segment independently (does not encode the separator itself)', () => {
		expect(encodeObjectKey('a b/c d')).toBe('a%20b/c%20d');
	});

	it('handles a key with no slashes at all', () => {
		expect(encodeObjectKey('no-slashes-here')).toBe('no-slashes-here');
	});
});
