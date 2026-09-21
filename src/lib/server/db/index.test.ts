import { describe, it, expect, vi } from 'vitest';
import { getDb, DbConfigError } from './index';

vi.mock('./libsql', () => ({
	createLibsqlDb: vi.fn((url: string, authToken?: string) => ({
		__backend: 'libsql',
		url,
		authToken
	}))
}));

vi.mock('drizzle-orm/d1', () => ({
	drizzle: vi.fn(() => ({ __backend: 'd1' }))
}));

const fakeD1 = {} as D1Database;

describe('getDb backend selection', () => {
	it('uses the D1 binding when no libSQL url is configured', () => {
		expect(getDb({ DB: fakeD1 })).toMatchObject({ __backend: 'd1' });
	});

	it('uses libSQL when LIBSQL_URL is set', () => {
		expect(getDb({ LIBSQL_URL: 'https://db.example' })).toMatchObject({
			__backend: 'libsql',
			url: 'https://db.example'
		});
	});

	it('forwards the auth token to the libSQL client', () => {
		expect(getDb({ LIBSQL_URL: 'https://db.example', LIBSQL_AUTH_TOKEN: 'tok' })).toMatchObject({
			authToken: 'tok'
		});
	});

	// Both bound is the state a deployment is in *during* a migration, with
	// the D1 binding still in wrangler.jsonc while traffic has already been
	// pointed at libSQL. Silently preferring D1 there would quietly keep
	// serving the old database from the operator's point of view.
	it('prefers libSQL over a D1 binding when both are present', () => {
		expect(getDb({ DB: fakeD1, LIBSQL_URL: 'https://db.example' })).toMatchObject({
			__backend: 'libsql'
		});
	});

	// A blank var is what an unset secret or an empty `wrangler.jsonc`
	// entry looks like at runtime; treating it as "libSQL configured"
	// would hand the client an empty url instead of falling back to D1.
	it('ignores an empty LIBSQL_URL and falls back to D1', () => {
		expect(getDb({ DB: fakeD1, LIBSQL_URL: '' })).toMatchObject({ __backend: 'd1' });
	});

	it('fails loudly when neither backend is configured', () => {
		expect(() => getDb({})).toThrow(DbConfigError);
	});
});
