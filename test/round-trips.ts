import { getDb, type Db } from '../src/lib/server/db';

/**
 * Workers' per-invocation subrequest limit on the free plan.
 *
 * On a self-hosted libSQL database every query a request makes is a fetch
 * and counts against this. D1 calls draw on a separate, much larger
 * allowance, so code that is fine against the D1 these tests run on can
 * still fail in production — which is what these counts are for.
 */
export const SUBREQUEST_LIMIT = 50;

export interface CountedDb {
	db: Db;
	/** Round trips to the database since creation or the last reset. */
	readonly roundTrips: number;
	reset(): void;
}

/**
 * A Db over `d1` that counts round trips: each statement executed on its
 * own is one, and a whole batch is one — exactly the number of fetches the
 * same calls would make against libSQL over HTTP.
 */
export function countRoundTrips(d1: D1Database): CountedDb {
	let roundTrips = 0;
	// Drizzle hands the statements it prepared back to batch(); workerd only
	// accepts its own objects there, so each wrapper remembers what it wraps.
	const unwrapped = new WeakMap<object, D1PreparedStatement>();

	const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
		const wrapper = new Proxy(statement, {
			get(target, property) {
				if (property === 'bind') {
					return (...values: unknown[]) => wrapStatement(target.bind(...values));
				}
				if (
					property === 'run' ||
					property === 'all' ||
					property === 'first' ||
					property === 'raw'
				) {
					return (...args: unknown[]) => {
						roundTrips++;
						return (target[property] as (...a: unknown[]) => unknown)(...args);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		unwrapped.set(wrapper, statement);
		return wrapper;
	};

	const database = new Proxy(d1, {
		get(target, property) {
			if (property === 'prepare') return (query: string) => wrapStatement(target.prepare(query));
			if (property === 'batch') {
				return (statements: D1PreparedStatement[]) => {
					roundTrips++;
					return target.batch(statements.map((s) => unwrapped.get(s) ?? s));
				};
			}
			if (property === 'exec') {
				return (query: string) => {
					roundTrips++;
					return target.exec(query);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});

	return {
		db: getDb({ DB: database }),
		get roundTrips() {
			return roundTrips;
		},
		reset() {
			roundTrips = 0;
		}
	};
}
