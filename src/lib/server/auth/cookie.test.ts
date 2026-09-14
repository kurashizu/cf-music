import { describe, it, expect } from 'vitest';
import { sessionCookieOptions, clearedSessionCookieOptions, SESSION_COOKIE_NAME } from './cookie';

describe('SESSION_COOKIE_NAME', () => {
	it('is a non-empty string', () => {
		expect(SESSION_COOKIE_NAME).toBe('session');
	});
});

describe('sessionCookieOptions', () => {
	it('sets HttpOnly, Secure, and SameSite=Lax for defense in depth', () => {
		const options = sessionCookieOptions(new Date('2026-06-01T00:00:00.000Z'));
		expect(options.httpOnly).toBe(true);
		expect(options.secure).toBe(true);
		expect(options.sameSite).toBe('lax');
	});

	it('scopes the cookie to the whole site', () => {
		const options = sessionCookieOptions(new Date());
		expect(options.path).toBe('/');
	});

	it('sets expires to exactly the given date', () => {
		const expiresAt = new Date('2026-06-01T00:00:00.000Z');
		const options = sessionCookieOptions(expiresAt);
		expect(options.expires).toBe(expiresAt);
	});
});

describe('clearedSessionCookieOptions', () => {
	it('sets maxAge to 0 so the browser deletes it immediately', () => {
		const options = clearedSessionCookieOptions();
		expect(options.maxAge).toBe(0);
	});

	it('still carries the same security attributes as an active session cookie', () => {
		const options = clearedSessionCookieOptions();
		expect(options.httpOnly).toBe(true);
		expect(options.secure).toBe(true);
		expect(options.sameSite).toBe('lax');
		expect(options.path).toBe('/');
	});
});
