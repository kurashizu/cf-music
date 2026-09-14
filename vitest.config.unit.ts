import { defineConfig } from 'vitest/config';

/**
 * Minimal, single-project Vitest config covering only pure logic
 * (no Cloudflare Workers bindings, no SvelteKit plugin pipeline).
 *
 * Kept separate from vite.config.ts because StrykerJS's Vitest runner
 * cannot select a single project out of a multi-project workspace
 * config (see stryker-mutator/stryker-js#6215), and mutating code that
 * touches D1Database/DurableObject types under vitest-pool-workers
 * isn't meaningful anyway — that surface is covered by integration
 * tests instead.
 */
export default defineConfig({
	test: {
		environment: 'node',
		include: [
			'src/lib/server/auth/**/*.test.ts',
			'src/lib/server/eviction/**/*.test.ts',
			'src/lib/server/http/**/*.test.ts',
			'src/lib/server/import/webhook-auth.test.ts',
			'src/lib/server/storage/**/*.test.ts',
			'src/lib/shared/**/*.test.ts'
		],
		// *.integration.test.ts needs Cloudflare Workers bindings (`cloudflare:test`)
		// and runs separately under vitest.config.workers.ts instead.
		exclude: ['src/lib/server/**/*.integration.test.ts']
	}
});
