/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	packageManager: 'npm',
	testRunner: 'vitest',
	vitest: {
		configFile: 'vitest.config.unit.ts'
	},
	// .svelte-kit is gitignored (it's a generated build artifact), but the root
	// tsconfig.json extends .svelte-kit/tsconfig.json, so it must be copied into
	// Stryker's sandbox too, or TS transform resolution fails there.
	files: ['src/**', 'vitest.config.unit.ts', 'tsconfig.json', '.svelte-kit/**'],
	// Only mutate pure logic that vitest.config.unit.ts actually exercises.
	// D1/Durable Object-bound code (service.ts) and SvelteKit-request-bound
	// code (guard.ts) are intentionally excluded — see the comment in
	// vitest.config.unit.ts for why mutation testing doesn't apply there.
	mutate: [
		'src/lib/server/auth/password.ts',
		'src/lib/server/auth/tokens.ts',
		'src/lib/server/auth/cookie.ts',
		'src/lib/server/eviction/score.ts',
		'src/lib/server/eviction/quota.ts',
		'src/lib/server/http/**/*.ts',
		'!src/lib/server/http/**/*.test.ts',
		'src/lib/server/storage/object-key.ts',
		'src/lib/server/import/webhook-auth.ts',
		'src/lib/server/import/event-body.ts',
		'src/lib/shared/**/*.ts',
		'!src/lib/shared/**/*.test.ts'
	],
	coverageAnalysis: 'perTest',
	reporters: ['html', 'clear-text', 'progress'],
	thresholds: {
		high: 90,
		low: 70,
		break: 60
	},
	tempDirName: '.stryker-tmp'
};
