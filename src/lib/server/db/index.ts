import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { createLibsqlDb } from './libsql';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch';
import * as schema from './schema';

/**
 * Deliberately the shared SQLite base type rather than one driver's
 * concrete class (DrizzleD1Database, LibSQLDatabase, ...): every caller
 * only ever uses dialect-neutral Drizzle query building, so naming a
 * driver here would make swapping it a 68-call-site type cascade instead
 * of a change contained to this file.
 *
 * Plus `batch`, which the base type doesn't declare but both drivers
 * implement with this same signature.
 */
export type Db = BaseSQLiteDatabase<'async', unknown, typeof schema> & {
	batch<U extends BatchItem<'sqlite'>, T extends Readonly<[U, ...U[]]>>(
		batch: T
	): Promise<BatchResponse<T>>;
};

/** Any statement `runInOneRequest` accepts: an insert, update, delete or select. */
export type Statement = BatchItem<'sqlite'>;

/**
 * Runs every statement in one round trip to the database, atomically.
 *
 * This is what keeps a request inside Workers' subrequest limit on a
 * self-hosted database. Every query there is its own fetch, and a Worker
 * on the free plan may make 50 of them per invocation — while D1 calls
 * count against a separate allowance of 1,000, which is why code that
 * awaited one query per song or per playlist worked on D1 and failed at
 * the 51st query once the database moved. A batch is one fetch however
 * many statements it holds.
 *
 * It is also a transaction on both backends: a batch that fails part way
 * leaves nothing behind, where the same statements awaited one by one
 * would stop at whatever they had reached.
 */
export async function runInOneRequest(db: Db, statements: Statement[]): Promise<void> {
	if (statements.length === 0) return;
	await db.batch(statements as [Statement, ...Statement[]]);
}

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
