import { test, expect, type Page } from '@playwright/test';
import { issueInviteCode, uniqueSuffix } from './fixtures';

// bits-ui keeps the inactive Tabs.Content in the DOM (hidden, not removed),
// so both the login and register forms' "用户名"/"密码" labels exist at once —
// scope every fill to the currently visible tabpanel to avoid strict-mode
// ambiguity between the two same-labelled inputs.
function loginPanel(page: Page) {
	return page.getByRole('tabpanel', { name: '登录' });
}

function registerPanel(page: Page) {
	return page.getByRole('tabpanel', { name: '注册' });
}

async function register(page: Page, opts: { username: string; password: string; inviteCode: string }) {
	await page.getByRole('tab', { name: '注册' }).click();
	const panel = registerPanel(page);
	await panel.getByLabel('用户名').fill(opts.username);
	await panel.getByLabel('密码').fill(opts.password);
	await panel.getByLabel('邀请码').fill(opts.inviteCode);
	await panel.getByRole('button', { name: '注册' }).click();
}

async function login(page: Page, opts: { username: string; password: string }) {
	const panel = loginPanel(page);
	await panel.getByLabel('用户名').fill(opts.username);
	await panel.getByLabel('密码').fill(opts.password);
	await panel.getByRole('button', { name: '登录' }).click();
}

test.describe('login page', () => {
	test('shows the login tab by default with username and password fields', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByRole('tab', { name: '登录' })).toHaveAttribute('data-state', 'active');
		await expect(loginPanel(page).getByLabel('用户名')).toBeVisible();
		await expect(loginPanel(page).getByLabel('密码')).toBeVisible();
		await expect(registerPanel(page)).toBeHidden();
	});

	test('switches to the register tab and reveals the invite code field', async ({ page }) => {
		await page.goto('/');

		await page.getByRole('tab', { name: '注册' }).click();

		await expect(page.getByRole('tab', { name: '注册' })).toHaveAttribute('data-state', 'active');
		await expect(registerPanel(page).getByLabel('邀请码')).toBeVisible();
	});

	test('rejects login with an unknown username', async ({ page }) => {
		await page.goto('/');

		await login(page, {
			username: `e2e-nonexistent-${uniqueSuffix()}`,
			password: 'irrelevant-password'
		});

		await expect(page.getByText('Invalid username or password')).toBeVisible();
		await expect(page).toHaveURL('/');
	});

	test('rejects registration with an invalid invite code', async ({ page }) => {
		await page.goto('/');

		await register(page, {
			username: `e2e-user-${uniqueSuffix()}`,
			password: 'correct-horse-battery',
			inviteCode: 'not-a-real-code'
		});

		await expect(page.getByText('Invite code is invalid or already used')).toBeVisible();
		await expect(page).toHaveURL('/');
	});

	test('registers, auto-logs-in, and redirects to the library', async ({ page }) => {
		const inviteCode = issueInviteCode();
		const username = `e2e-user-${uniqueSuffix()}`;

		await page.goto('/');
		await register(page, { username, password: 'correct-horse-battery', inviteCode });

		await expect(page).toHaveURL('/library');
		await expect(page.getByText(`已登录：${username}`)).toBeVisible();
	});

	test('an invite code cannot be reused after registration', async ({ page }) => {
		const inviteCode = issueInviteCode();
		const firstUsername = `e2e-user-${uniqueSuffix()}`;

		await page.goto('/');
		await register(page, { username: firstUsername, password: 'correct-horse-battery', inviteCode });
		await expect(page).toHaveURL('/library');

		await page.getByRole('button', { name: '退出登录' }).click();
		await expect(page).toHaveURL('/');

		const secondUsername = `e2e-user-${uniqueSuffix()}`;
		await register(page, { username: secondUsername, password: 'another-password', inviteCode });

		await expect(page.getByText('Invite code is invalid or already used')).toBeVisible();
		await expect(page).toHaveURL('/');
	});

	test('logs in with a registered account, then logs out', async ({ page }) => {
		const inviteCode = issueInviteCode();
		const username = `e2e-user-${uniqueSuffix()}`;
		const password = 'correct-horse-battery';

		await page.goto('/');
		await register(page, { username, password, inviteCode });
		await expect(page).toHaveURL('/library');

		await page.getByRole('button', { name: '退出登录' }).click();
		await expect(page).toHaveURL('/');

		await login(page, { username, password });

		await expect(page).toHaveURL('/library');
		await expect(page.getByText(`已登录：${username}`)).toBeVisible();

		await page.getByRole('button', { name: '退出登录' }).click();
		await expect(page).toHaveURL('/');
	});

	test('redirects unauthenticated visitors away from the library', async ({ page }) => {
		await page.goto('/library');

		await expect(page).toHaveURL('/');
		await expect(page.getByRole('tab', { name: '登录' })).toBeVisible();
	});
});
