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
	// Both projects run against the system-installed Google Chrome
	// (`channel: 'chrome'`), never Playwright's bundled Chromium — named
	// accordingly, since a project called "chromium" reads as the opposite
	// of what it does.
	projects: [
		{
			name: 'chrome',
			use: { ...devices['Desktop Chrome'], channel: 'chrome' }
		},
		{
			name: 'mobile-chrome',
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
