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
	test('desktop shows the sidebar nav and hides the mobile chrome', async ({ page, isMobile }) => {
		test.skip(isMobile, 'desktop-only assertion');
		await registerAndLand(page);

		const sidebar = page.locator('aside');
		const mobileNav = page.getByRole('navigation', { name: 'Primary (mobile)' });

		await expect(sidebar).toBeVisible();
		await expect(mobileNav).toBeHidden();
		// The mobile-only header carries the logo and build info the sidebar
		// footer already shows, so it must not double up on desktop.
		await expect(page.locator('header')).toBeHidden();
		await expect(sidebar.getByRole('link', { name: 'Settings' })).toBeVisible();
	});

	test('mobile shows the bottom nav and header, and hides the sidebar', async ({
		page,
		isMobile
	}) => {
		test.skip(!isMobile, 'mobile-only assertion');
		await registerAndLand(page);

		const sidebar = page.locator('aside');
		const mobileNav = page.getByRole('navigation', { name: 'Primary (mobile)' });

		await expect(mobileNav).toBeVisible();
		await expect(sidebar).toBeHidden();
		await expect(page.locator('header')).toBeVisible();
		// Settings is reachable from the bottom nav, since the sidebar's own
		// entry for it is off-screen here.
		await expect(mobileNav.getByRole('link', { name: 'Settings' })).toBeVisible();
	});

	test('logging out is reachable from settings on either breakpoint', async ({ page }) => {
		await registerAndLand(page);

		await page.goto('/settings');

		await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
	});
});
