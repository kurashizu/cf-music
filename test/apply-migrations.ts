import { applyD1Migrations, env } from 'cloudflare:test';

// Idempotent: skips migrations that are already recorded as applied, so
// this can safely run once per test file without manual bookkeeping.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
