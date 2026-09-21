import { drizzle } from 'drizzle-orm/d1';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema';

export const getDb = (d1: D1Database) => drizzle(d1, { schema });

/**
 * Deliberately the shared SQLite base type rather than
 * `ReturnType<typeof getDb>`: every caller only ever uses dialect-neutral
 * Drizzle query building, so pinning them to one driver's concrete class
 * (DrizzleD1Database, LibSQLDatabase, ...) would make swapping the driver
 * a 68-call-site type cascade instead of a one-line change here.
 */
export type Db = BaseSQLiteDatabase<'async', unknown, typeof schema>;
