import { test, expect, type Page } from '@playwright/test';
import { issueInviteCode, uniqueSuffix } from './fixtures';

async function registerAndLand(page: Page): Promise<string> {
	const inviteCode = issueInviteCode();
	const username = `e2e-user-${uniqueSuffix()}`;
	await page.goto('/');
	await page.getByRole('tab', { name: 'Register' }).click();
	const panel = page.getByRole('tabpanel', { name: 'Register' });
	await panel.getByLabel('Username').fill(username);
	await panel.getByLabel('Password').fill('correct-horse-battery');
	await panel.getByLabel('Invite code').fill(inviteCode);
	await panel.getByRole('button', { name: 'Register' }).click();
	await expect(page).toHaveURL('/library');
	return username;
}

test.describe('import page', () => {
	test('shows the link form and playlist select with no jobs initially', async ({ page }) => {
		await registerAndLand(page);

		await page.getByRole('link', { name: 'Import' }).first().click();
		await expect(page).toHaveURL('/import');

		await expect(page.getByLabel('Link')).toBeVisible();
		await expect(page.getByText('Add to playlist')).toBeVisible();
		await expect(page.getByText('Recent imports')).toBeHidden();
	});

	test('a submitted job still shows up in recent imports after a refresh, even if the GitHub dispatch itself failed', async ({
		page
	}) => {
		// The local/CI test environment has no real GitHub Actions token, so
		// dispatchImportWorkflow always fails here — this exercises the same
		// "job exists in D1 but the browser never got the success response"
		// gap that a real dispatch failure would also hit, and confirms
		// listImportJobs' refresh-recovery path (not a happy-path dispatch,
		// which would need a real GitHub token to test for real).
		await registerAndLand(page);
		await page.goto('/import');

		await page.getByLabel('Link').fill('https://example.com/a-video');
		await page.getByRole('button', { name: 'Import' }).click();
		await expect(page.getByText('Failed to start import')).toBeVisible();

		await page.reload();

		await expect(page.getByText('https://example.com/a-video')).toBeVisible();
	});
});
