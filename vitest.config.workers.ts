import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

/**
 * Runs inside a real workerd instance via Miniflare, so D1/Durable Object/
 * KV bindings behave like production. Kept separate from vite.config.ts and
 * vitest.config.unit.ts: StrykerJS's Vitest runner can't select a single
 * project out of a workspace, and mutation-testing binding-shaped code here
 * isn't meaningful anyway (see vitest.config.unit.ts for the pure-logic
 * suite that Stryker actually mutates).
 */
export default defineConfig(async () => {
	const migrationsPath = path.join(import.meta.dirname, 'migrations');
	const migrations = await readD1Migrations(migrationsPath);

	return {
		plugins: [
			cloudflareTest({
				// No `wrangler.configPath`/`main` here: these tests import the D1
				// data-access layer directly as plain TS modules rather than
				// dispatching HTTP requests through the SvelteKit Worker's build
				// output, so only a D1 binding is needed — not the full app worker.
				miniflare: {
					// The pinned miniflare/workerd inside @cloudflare/vitest-pool-workers
					// lags behind the wrangler.jsonc compatibility_date used for real
					// deploys (which is validated against the locally-installed, newer
					// wrangler/workerd instead). Pin an older-but-compatible date here.
					compatibilityDate: '2026-08-22',
					d1Databases: ['DB'],
					kvNamespaces: ['SESSION_KV'],
					bindings: { TEST_MIGRATIONS: migrations }
				}
			})
		],
		test: {
			include: ['src/lib/server/**/*.integration.test.ts'],
			setupFiles: ['./test/apply-migrations.ts']
		}
	};
});
