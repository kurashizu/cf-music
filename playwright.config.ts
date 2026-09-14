import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
	testDir: './e2e',
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: BASE_URL,
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'], channel: 'chrome' }
		},
		{
			name: 'mobile-chromium',
			use: { ...devices['Pixel 7'], channel: 'chrome' }
		}
	],
	globalSetup: './e2e/global-setup.ts',
	webServer: {
		command: 'npm run build && npx wrangler dev --port 4173',
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000
	}
});
