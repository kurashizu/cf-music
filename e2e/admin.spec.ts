import { test, expect, type Page } from '@playwright/test';
import { issueInviteCode, uniqueSuffix, promoteToAdmin } from './fixtures';

async function registerAndLogin(page: Page): Promise<{ userId: string; username: string }> {
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

	// page.request is a separate API-testing client, not the browser's own
	// network stack — it doesn't get Chrome's "treat localhost as a secure
	// context" carve-out, so it never attaches our Secure session cookie
	// over the plain-HTTP test server and silently gets a 401. Calling
	// fetch() from inside the page itself goes through the real browser
	// cookie jar instead.
	const body = await page.evaluate(async () => {
		const response = await fetch('/api/auth/me');
		return response.json();
	});
	return { userId: body.userId, username };
}

test.describe('admin access control', () => {
	test('a non-admin user has no Admin link and is redirected away from /admin', async ({
		page
	}) => {
		await registerAndLogin(page);

		await expect(page.getByRole('link', { name: 'Admin' })).toBeHidden();

		await page.goto('/admin');
		await expect(page).toHaveURL('/library');
	});
});

test.describe('admin panel', () => {
	async function registerAdminAndReload(page: Page) {
		const { userId, username } = await registerAndLogin(page);
		promoteToAdmin(userId);
		// isAdmin is baked into the session data resolved at request time
		// (see hooks.server.ts), not re-checked per navigation, so a fresh
		// full-page load is needed after flipping the DB row directly.
		await page.reload();
		return { userId, username };
	}

	test('shows the Admin entry on settings and lets an admin reach the page', async ({ page }) => {
		await registerAdminAndReload(page);

		// Admin is reached from the settings page rather than the app shell's
		// nav, alongside the other account-scoped destinations.
		await page.goto('/settings');
		const adminLink = page.getByRole('link').filter({ hasText: 'Admin' });
		await expect(adminLink).toBeVisible();

		await adminLink.click();
		await expect(page).toHaveURL('/admin');
		await expect(page.getByRole('tab', { name: 'Invites' })).toBeVisible();
	});

	test('generates a new invite code that appears in the list', async ({ page }) => {
		await registerAdminAndReload(page);
		await page.goto('/admin');

		await page.getByRole('button', { name: 'New invite code' }).click();

		await expect(page.getByText('Invite code created')).toBeVisible();
		await expect(page.getByText('Available').first()).toBeVisible();
	});

	test('lists the admin\'s own user row and lets it edit its own quota', async ({ page }) => {
		const { username } = await registerAdminAndReload(page);
		await page.goto('/admin');

		await page.getByRole('tab', { name: 'Users' }).click();
		// Other admin users from earlier tests in this file (and from the other
		// Playwright project sharing the same local D1) also appear in this
		// list, so scope everything to this test's own row rather than
		// asserting on page-wide text that another row could coincidentally
		// share (e.g. also reading "5.0 GB quota").
		const row = page.getByRole('listitem').filter({ hasText: username });
		await row.getByRole('button', { name: 'Edit quota' }).click();

		await expect(page.getByRole('heading', { name: /Edit quota for/ })).toBeVisible();

		const quotaInput = page.getByLabel('Quota (GB)');
		await quotaInput.fill('5');
		await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();

		await expect(page.getByText('Quota updated')).toBeVisible();
		// Rendered by the shared formatBytes, which scales to the unit that
		// actually fits — this page used to divide by 1024^3 unconditionally,
		// so a 200MB quota read as "0.20 GB" while every other page said
		// "200.0 MB".
		await expect(row.getByText('5.0 GB quota')).toBeVisible();
	});

	test('shows audit log entries after logging in and generating an invite code', async ({
		page
	}) => {
		await registerAdminAndReload(page);
		await page.goto('/admin');
		await page.getByRole('button', { name: 'New invite code' }).click();
		await expect(page.getByText('Invite code created')).toBeVisible();

		// The audit log is its own page, not a tab on the admin panel, and it
		// renders readable labels rather than the raw event type names.
		await page.getByRole('link', { name: 'Audit log' }).click();
		await expect(page).toHaveURL('/admin/audit-log');

		await expect(page.getByText('Invite created').first()).toBeVisible();
		await expect(page.getByText('Login', { exact: true }).first()).toBeVisible();
	});
});
