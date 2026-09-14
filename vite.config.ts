import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';

// Baked into the client bundle at build time so a deployed page's footer
// can be checked against `git log` to answer "did my latest push actually
// go out" without guessing from cache-busting or waiting on propagation —
// see BuildInfo.svelte. Falls back to "unknown" rather than failing the
// build if run somewhere without a git history (e.g. a shallow CI checkout).
function readCommitHash(): string {
	try {
		return execSync('git rev-parse --short HEAD').toString().trim();
	} catch {
		return 'unknown';
	}
}

export default defineConfig({
	define: {
		__BUILD_COMMIT__: JSON.stringify(readCommitHash()),
		__BUILD_TIME__: JSON.stringify(new Date().toISOString())
	},
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			typescript: {
				config: (config) => {
					config.include.push('../drizzle.config.ts');
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html', 'json-summary'],
			include: ['src/lib/**/*.ts'],
			exclude: [
				'src/lib/**/*.test.ts',
				'src/lib/**/*.spec.ts',
				'src/lib/index.ts', // barrel re-export file, no logic of its own
				// D1-bound modules: covered by *.integration.test.ts under
				// vitest.config.workers.ts instead of the unit/CRAP pipeline here.
				'src/lib/server/db/**',
				'src/lib/server/library/**',
				'src/lib/server/auth/service.ts',
				'src/lib/server/eviction/usage.ts',
				'src/lib/server/eviction/execute.ts',
				'src/lib/server/import/jobs.ts',
				'src/lib/server/import/github-actions.ts', // makes real network calls to the GitHub API; not covered by any automated test tier
				'src/lib/server/durable-objects/**', // Workers-runtime bound (WebSocketPair, DurableObjectState); no automated test tier covers these yet
				'src/lib/server/storage/s3.ts' // makes real network calls to MinIO; not covered by any automated test tier
			]
		},
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					// *.integration.test.ts requires D1/Workers bindings and runs
					// separately under vitest.config.workers.ts (see `npm run test:integration`).
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'src/**/*.integration.test.ts']
				}
			}
		]
	}
});
