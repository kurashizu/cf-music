import { applyD1Migrations, env } from 'cloudflare:test';

// These tests run against a local D1 provided by Miniflare (see
// `d1Databases` in vitest.config.workers.ts), not the deployed database —
// the data-access layer is dialect-neutral, so exercising it on SQLite
// here covers it whichever backend production is pointed at. `DB` is
// therefore absent from the generated Env type and declared locally.
const testEnv = env as unknown as {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

// Idempotent: skips migrations that are already recorded as applied, so
// this can safely run once per test file without manual bookkeeping.
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
