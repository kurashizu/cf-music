import { test, expect, type Page } from '@playwright/test';
import { issueInviteCode, uniqueSuffix } from './fixtures';

// bits-ui keeps the inactive Tabs.Content in the DOM (hidden, not removed),
// so both the login and register forms' "Username"/"Password" labels exist at once —
// scope every fill to the currently visible tabpanel to avoid strict-mode
// ambiguity between the two same-labelled inputs.
function loginPanel(page: Page) {
	return page.getByRole('tabpanel', { name: 'Login' });
}

function registerPanel(page: Page) {
	return page.getByRole('tabpanel', { name: 'Register' });
}

async function register(page: Page, opts: { username: string; password: string; inviteCode: string }) {
	await page.getByRole('tab', { name: 'Register' }).click();
	const panel = registerPanel(page);
	await panel.getByLabel('Username').fill(opts.username);
	await panel.getByLabel('Password').fill(opts.password);
	await panel.getByLabel('Invite code').fill(opts.inviteCode);
	await panel.getByRole('button', { name: 'Register' }).click();
}

async function login(page: Page, opts: { username: string; password: string }) {
	const panel = loginPanel(page);
	await panel.getByLabel('Username').fill(opts.username);
	await panel.getByLabel('Password').fill(opts.password);
	await panel.getByRole('button', { name: 'Login' }).click();
}

// The desktop sidebar and mobile header each render their own "Log out"
// button; only one is visually shown per breakpoint via CSS (display:none
// on the other), so scope by container instead of relying on visibility
// filtering, which strict mode would otherwise reject as ambiguous.
async function logout(page: Page) {
	const sidebarButton = page.locator('aside').getByRole('button', { name: 'Log out' });
	const headerButton = page.locator('header').getByRole('button', { name: 'Log out' });
	const visible = (await sidebarButton.isVisible()) ? sidebarButton : headerButton;
	await visible.click();
}

test.describe('login page', () => {
	test('shows the login tab by default with username and password fields', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByRole('tab', { name: 'Login' })).toHaveAttribute('data-state', 'active');
		await expect(loginPanel(page).getByLabel('Username')).toBeVisible();
		await expect(loginPanel(page).getByLabel('Password')).toBeVisible();
		await expect(registerPanel(page)).toBeHidden();
	});

	test('switches to the register tab and reveals the invite code field', async ({ page }) => {
		await page.goto('/');

		await page.getByRole('tab', { name: 'Register' }).click();

		await expect(page.getByRole('tab', { name: 'Register' })).toHaveAttribute('data-state', 'active');
		await expect(registerPanel(page).getByLabel('Invite code')).toBeVisible();
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
		await expect(page.getByText('Your playlists')).toBeVisible();
	});

	test('an invite code cannot be reused after registration', async ({ page }) => {
		const inviteCode = issueInviteCode();
		const firstUsername = `e2e-user-${uniqueSuffix()}`;

		await page.goto('/');
		await register(page, { username: firstUsername, password: 'correct-horse-battery', inviteCode });
		await expect(page).toHaveURL('/library');

		await logout(page);
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

		await logout(page);
		await expect(page).toHaveURL('/');

		await login(page, { username, password });

		await expect(page).toHaveURL('/library');
		await expect(page.getByText('Your playlists')).toBeVisible();

		await logout(page);
		await expect(page).toHaveURL('/');
	});

	test('redirects unauthenticated visitors away from the library', async ({ page }) => {
		await page.goto('/library');

		await expect(page).toHaveURL('/');
		await expect(page.getByRole('tab', { name: 'Login' })).toBeVisible();
	});
});
