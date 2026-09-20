import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, timingSafeEqual, parseStoredHash } from './password';

describe('hashPassword / verifyPassword', () => {
	it('produces a hash in the expected pbkdf2$iterations$salt$hash format', async () => {
		const hash = await hashPassword('correct-horse-battery-staple');
		const parts = hash.split('$');
		expect(parts).toHaveLength(4);
		expect(parts[0]).toBe('pbkdf2');
		expect(Number(parts[1])).toBeGreaterThan(0);
		expect(parts[2]).toMatch(/^[0-9a-f]{32}$/); // 16 bytes salt
		expect(parts[3]).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hash
	});

	it('verifies a correct password against its own hash', async () => {
		const hash = await hashPassword('my-secret-password');
		await expect(verifyPassword('my-secret-password', hash)).resolves.toBe(true);
	});

	it('rejects an incorrect password', async () => {
		const hash = await hashPassword('my-secret-password');
		await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
	});

	it('rejects an empty password against a real hash', async () => {
		const hash = await hashPassword('my-secret-password');
		await expect(verifyPassword('', hash)).resolves.toBe(false);
	});

	it('produces different salts (and thus different hashes) for the same password', async () => {
		const hashA = await hashPassword('same-password');
		const hashB = await hashPassword('same-password');
		expect(hashA).not.toBe(hashB);
	});

	it('rejects a structurally invalid stored hash', async () => {
		await expect(verifyPassword('anything', 'not-a-valid-hash')).resolves.toBe(false);
	});
});

describe('parseStoredHash', () => {
	it('parses a well-formed hash into its components', () => {
		const parsed = parseStoredHash(
			'pbkdf2$210000$aabbccddeeff00112233445566778899$' + 'a'.repeat(64)
		);
		expect(parsed).not.toBeNull();
		expect(parsed?.iterations).toBe(210000);
		expect(parsed?.salt).toHaveLength(16);
		expect(parsed?.expectedHex).toBe('a'.repeat(64));
	});

	it('rejects a string with fewer than 4 segments', () => {
		expect(parseStoredHash('pbkdf2$1$2')).toBeNull();
	});

	it('rejects a string with more than 4 segments', () => {
		expect(parseStoredHash('pbkdf2$1$2$3$4')).toBeNull();
	});

	it('rejects 5 segments even when the first 4 are otherwise perfectly well-formed', () => {
		// Isolates the segment-count guard: every other guard would pass if it
		// were skipped, so only the `parts.length !== 4` check can catch this.
		const wellFormed =
			'pbkdf2$210000$' + 'aa'.repeat(16) + '$' + 'a'.repeat(64) + '$unexpected-trailing-segment';
		expect(parseStoredHash(wellFormed)).toBeNull();
	});

	it('rejects exactly 4 segments when the algorithm tag is wrong', () => {
		expect(parseStoredHash('bcrypt$210000$' + 'aa'.repeat(16) + '$' + 'a'.repeat(64))).toBeNull();
	});

	it('rejects a non-numeric iteration count', () => {
		expect(
			parseStoredHash('pbkdf2$not-a-number$' + 'aa'.repeat(16) + '$' + 'a'.repeat(64))
		).toBeNull();
	});

	it('rejects an iteration count of exactly 0', () => {
		expect(parseStoredHash('pbkdf2$0$' + 'aa'.repeat(16) + '$' + 'a'.repeat(64))).toBeNull();
	});

	it('rejects a negative iteration count', () => {
		expect(parseStoredHash('pbkdf2$-5$' + 'aa'.repeat(16) + '$' + 'a'.repeat(64))).toBeNull();
	});

	it('accepts an iteration count of exactly 1 (boundary)', () => {
		expect(parseStoredHash('pbkdf2$1$' + 'aa'.repeat(16) + '$' + 'a'.repeat(64))).not.toBeNull();
	});

	it('rejects a salt shorter than 16 bytes, even with a correctly-sized hash segment', () => {
		expect(parseStoredHash('pbkdf2$210000$aabb$' + 'a'.repeat(64))).toBeNull();
	});

	it('rejects an empty salt segment (regex hex-pair match finds nothing)', () => {
		expect(parseStoredHash('pbkdf2$210000$$' + 'a'.repeat(64))).toBeNull();
	});

	it('rejects a hash segment shorter than 32 bytes, even with a correctly-sized salt', () => {
		expect(parseStoredHash('pbkdf2$210000$' + 'aa'.repeat(16) + '$ab')).toBeNull();
	});

	it('rejects when both salt and hash segments are the wrong length', () => {
		expect(parseStoredHash('pbkdf2$210000$aabb$ab')).toBeNull();
	});
});

describe('timingSafeEqual', () => {
	it('returns true for identical strings', () => {
		expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
	});

	it('returns false for strings differing only in the first character', () => {
		expect(timingSafeEqual('zbc123', 'abc123')).toBe(false);
	});

	it('returns false for strings differing only in the last character', () => {
		expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
	});

	it('returns false for strings of different lengths', () => {
		expect(timingSafeEqual('short', 'muchlonger')).toBe(false);
	});

	it('returns false when the shorter string is an exact prefix of the longer one', () => {
		// Isolates the length guard: if it were skipped, comparing only up to
		// the shorter string's length would find no differing characters and
		// incorrectly report equality.
		expect(timingSafeEqual('abc', 'abcdef')).toBe(false);
	});

	it('returns true for two empty strings', () => {
		expect(timingSafeEqual('', '')).toBe(true);
	});
});
