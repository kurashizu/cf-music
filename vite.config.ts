import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
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
				'src/lib/server/db/**', // Drizzle schema/binding wiring, exercised via integration tests, not unit CRAP scoring
				'src/lib/server/auth/service.ts' // D1-bound; covered by *.integration.test.ts under vitest.config.workers.ts instead
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
