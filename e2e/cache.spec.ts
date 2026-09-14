import { test, expect, type Page } from '@playwright/test';
import { issueInviteCode, uniqueSuffix, seedPlaylistWithSongs } from './fixtures';

async function registerViaApi(page: Page): Promise<{ userId: string; username: string }> {
	const inviteCode = issueInviteCode();
	const username = `e2e-user-${uniqueSuffix()}`;
	const response = await page.request.post('/api/auth/register', {
		data: { username, password: 'correct-horse-battery', inviteCode }
	});
	const body = await response.json();
	return { userId: body.userId, username };
}

test.describe('cache page', () => {
	test('shows an empty state with no songs', async ({ page }) => {
		await registerViaApi(page);

		await page.goto('/cache');

		await expect(page.getByText('No songs in your library yet.')).toBeVisible();
	});

	test('lists every song in the library defaulted to lazy (Pin button, not Pinned)', async ({
		page
	}) => {
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		const tracks = seedPlaylistWithSongs(userId, playlistId, 'Cache Test Playlist', 2);

		await page.goto('/cache');

		await expect(page.getByText(tracks[0].title)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Pin', exact: true }).first()).toBeVisible();
	});

	test('pinning a song flips the button to Pinned and persists across reload', async ({ page }) => {
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		const tracks = seedPlaylistWithSongs(userId, playlistId, 'Cache Pin Test Playlist', 1);

		await page.goto('/cache');
		await page.getByRole('button', { name: 'Pin', exact: true }).click();

		await expect(page.getByRole('button', { name: 'Pinned' })).toBeVisible();

		await page.reload();

		await expect(page.getByRole('button', { name: 'Pinned' })).toBeVisible();
		await expect(page.getByText(tracks[0].title)).toBeVisible();
	});

	test('unpinning a previously pinned song flips it back to Pin', async ({ page }) => {
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		seedPlaylistWithSongs(userId, playlistId, 'Cache Unpin Test Playlist', 1);

		await page.goto('/cache');
		await page.getByRole('button', { name: 'Pin', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Pinned' })).toBeVisible();

		await page.getByRole('button', { name: 'Pinned' }).click();

		await expect(page.getByRole('button', { name: 'Pin', exact: true })).toBeVisible();
	});
});
