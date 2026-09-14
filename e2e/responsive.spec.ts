import { test, expect } from '@playwright/test';
import { issueInviteCode, uniqueSuffix } from './fixtures';

async function registerAndLand(page: import('@playwright/test').Page) {
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
}

test.describe('responsive app shell', () => {
	test('desktop shows the sidebar nav and hides the mobile bottom nav', async ({
		page,
		isMobile
	}) => {
		test.skip(isMobile, 'desktop-only assertion');
		await registerAndLand(page);

		const sidebar = page.locator('aside');
		const mobileNav = page.getByRole('navigation', { name: 'Primary (mobile)' });

		await expect(sidebar).toBeVisible();
		await expect(mobileNav).toBeHidden();
		await expect(sidebar.getByRole('button', { name: 'Log out' })).toBeVisible();
	});

	test('mobile shows the bottom nav and hides the sidebar', async ({ page, isMobile }) => {
		test.skip(!isMobile, 'mobile-only assertion');
		await registerAndLand(page);

		const sidebar = page.locator('aside');
		const mobileNav = page.getByRole('navigation', { name: 'Primary (mobile)' });
		const mobileHeader = page.locator('header');

		await expect(mobileNav).toBeVisible();
		await expect(sidebar).toBeHidden();
		await expect(mobileHeader.getByRole('button', { name: 'Log out' })).toBeVisible();
	});
});
