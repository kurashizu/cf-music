import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { createLibsqlDb } from './libsql';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema';

/**
 * Deliberately the shared SQLite base type rather than one driver's
 * concrete class (DrizzleD1Database, LibSQLDatabase, ...): every caller
 * only ever uses dialect-neutral Drizzle query building, so naming a
 * driver here would make swapping it a 68-call-site type cascade instead
 * of a change contained to this file.
 */
export type Db = BaseSQLiteDatabase<'async', unknown, typeof schema>;

/**
 * The bindings this module reads. D1 is the default and needs no
 * configuration beyond the binding itself; setting LIBSQL_URL is what
 * opts an instance into a self-hosted libSQL server instead.
 */
export interface DbEnv {
	DB?: D1Database;
	LIBSQL_URL?: string;
	LIBSQL_AUTH_TOKEN?: string;
}

export class DbConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DbConfigError';
	}
}

/**
 * Both backends speak the same SQLite dialect and are driven through the
 * same Drizzle query builder, so which one is in use is invisible to
 * every caller — the schema, migrations and queries are identical.
 *
 * D1 stays the default so a fork deploying this with nothing but the
 * stock `wrangler.jsonc` keeps working untouched. Self-hosting is opt-in
 * via LIBSQL_URL, for instances that would rather not meter reads per row
 * (see docs/self-hosted-database.md).
 */
export function getDb(env: DbEnv): Db {
	if (env.LIBSQL_URL) {
		return createLibsqlDb(env.LIBSQL_URL, env.LIBSQL_AUTH_TOKEN);
	}
	if (!env.DB) {
		throw new DbConfigError(
			'No database configured: bind D1 as `DB`, or set LIBSQL_URL to a libSQL server.'
		);
	}
	return drizzleD1(env.DB, { schema });
}
