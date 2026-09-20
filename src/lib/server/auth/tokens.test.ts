import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	generateSessionId,
	generateInviteCode,
	computeSessionExpiry,
	isSessionExpired
} from './tokens';

describe('generateSessionId', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('produces a 64-character hex string (32 bytes)', () => {
		const id = generateSessionId();
		expect(id).toMatch(/^[0-9a-f]{64}$/);
	});

	it('produces different values on successive calls', () => {
		const a = generateSessionId();
		const b = generateSessionId();
		expect(a).not.toBe(b);
	});

	it('zero-pads single-hex-digit byte values (e.g. 0x05 -> "05", not "5")', () => {
		// Deterministic: force the first byte to a single-hex-digit value.
		vi.spyOn(crypto, 'getRandomValues').mockImplementation(
			(array: ArrayBufferView<ArrayBuffer>) => {
				const bytes = array as unknown as Uint8Array;
				bytes[0] = 0x05;
				for (let i = 1; i < bytes.length; i++) bytes[i] = 0xff;
				return array;
			}
		);

		const id = generateSessionId();
		expect(id.startsWith('05')).toBe(true);
		expect(id).toHaveLength(64); // would be 63 if '0x05' were left unpadded as "5"
	});
});

describe('generateInviteCode', () => {
	it('produces 4 groups of 5 characters separated by hyphens', () => {
		const code = generateInviteCode();
		const groups = code.split('-');
		expect(groups).toHaveLength(4);
		for (const group of groups) {
			expect(group).toHaveLength(5);
		}
	});

	it('excludes ambiguous characters (0, O, 1, I)', () => {
		const code = generateInviteCode();
		expect(code).not.toMatch(/[0O1I]/);
	});

	it('produces different codes on successive calls', () => {
		const a = generateInviteCode();
		const b = generateInviteCode();
		expect(a).not.toBe(b);
	});
});

describe('computeSessionExpiry', () => {
	it('sets expiresAt exactly 30 days after createdAt', () => {
		const now = new Date('2026-01-01T00:00:00.000Z');
		const { createdAt, expiresAt } = computeSessionExpiry(now);
		expect(createdAt).toEqual(now);
		expect(expiresAt.getTime() - createdAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
	});

	it('defaults to the current time when no argument is given', () => {
		const before = Date.now();
		const { createdAt } = computeSessionExpiry();
		const after = Date.now();
		expect(createdAt.getTime()).toBeGreaterThanOrEqual(before);
		expect(createdAt.getTime()).toBeLessThanOrEqual(after);
	});
});

describe('isSessionExpired', () => {
	it('returns false when now is before expiresAt', () => {
		const expiresAt = new Date('2026-06-01T00:00:00.000Z');
		const now = new Date('2026-05-01T00:00:00.000Z');
		expect(isSessionExpired(expiresAt, now)).toBe(false);
	});

	it('returns true when now is after expiresAt', () => {
		const expiresAt = new Date('2026-06-01T00:00:00.000Z');
		const now = new Date('2026-07-01T00:00:00.000Z');
		expect(isSessionExpired(expiresAt, now)).toBe(true);
	});

	it('returns true when now exactly equals expiresAt (boundary)', () => {
		const expiresAt = new Date('2026-06-01T00:00:00.000Z');
		expect(isSessionExpired(expiresAt, expiresAt)).toBe(true);
	});
});
