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
	// D1/Durable Object-bound code is intentionally excluded — see the
	// comment in vitest.config.unit.ts for why mutation testing doesn't
	// apply there.
	mutate: [
		'src/lib/server/auth/**/*.ts',
		'!src/lib/server/auth/**/*.test.ts',
		'src/lib/server/eviction/**/*.ts',
		'!src/lib/server/eviction/**/*.test.ts',
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
