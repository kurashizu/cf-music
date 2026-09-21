import { drizzle } from 'drizzle-orm/libsql/http';
import { createClient } from '@libsql/client/http';
import * as schema from './schema';
import type { Db } from './index';

/**
 * The `/http` entrypoints specifically, not the package defaults: the
 * default @libsql/client selects a transport at runtime and pulls in the
 * WebSocket (Hrana) and node:* code paths, neither of which resolve under
 * workerd. HTTP is also the right transport on its own merits here — a
 * Worker invocation is too short-lived to amortise a persistent
 * connection.
 *
 * Kept in its own module so that a D1 deployment never reaches this
 * import at all.
 */
export function createLibsqlDb(url: string, authToken?: string): Db {
	return drizzle(createClient({ url, authToken }), { schema });
}
