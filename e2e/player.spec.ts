import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { issueInviteCode, uniqueSuffix, seedPlaylistWithSongs } from './fixtures';

const SILENCE_FIXTURE = path.join(import.meta.dirname, 'fixtures/silence.webm');

// Registers via the API directly (fast, and the register/login UI itself is
// already covered by auth.spec.ts) and returns the new user's id so the
// caller can seed a playlist for them before visiting any page.
async function registerViaApi(page: Page): Promise<{ userId: string; username: string }> {
	const inviteCode = issueInviteCode();
	const username = `e2e-user-${uniqueSuffix()}`;
	const response = await page.request.post('/api/auth/register', {
		data: { username, password: 'correct-horse-battery', inviteCode }
	});
	const body = await response.json();
	return { userId: body.userId, username };
}

// The seeded songs' audio_key points at a MinIO object that doesn't exist in
// this test environment; stub /api/stream-url so the <audio> element loads a
// real (tiny, local) file instead and playback events actually fire.
async function stubStreamUrls(page: Page) {
	await page.route('**/api/stream-url/**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				audioUrl: '/e2e-silence.webm',
				coverUrl: null,
				expiresInSeconds: 3600
			})
		});
	});
	await page.route('**/e2e-silence.webm', async (route) => {
		await route.fulfill({ status: 200, path: SILENCE_FIXTURE, contentType: 'audio/webm' });
	});
}

test.describe('playlist detail page', () => {
	test('lists songs with formatted durations and an empty state when there are none', async ({
		page
	}) => {
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		seedPlaylistWithSongs(userId, playlistId, 'Empty Test Playlist', 0);

		await page.goto(`/library/${playlistId}`);

		await expect(page.getByText('This playlist is empty')).toBeVisible();
	});

	test('shows every seeded track with its formatted duration', async ({ page }) => {
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		const tracks = seedPlaylistWithSongs(userId, playlistId, 'Full Test Playlist', 2);

		await page.goto(`/library/${playlistId}`);

		await expect(page.getByText(tracks[0].title)).toBeVisible();
		await expect(page.getByText(tracks[1].title)).toBeVisible();
		// First track is 30s -> "0:30"
		await expect(page.getByText('0:30')).toBeVisible();
	});

	// Each row's dropdown is only instantiated while that row's menu is open
	// (a scroll-performance measure — see the menu's own comment), so opening
	// one has to actually mount its items rather than reveal pre-built ones.
	test('opens a row menu and closes it again', async ({ page }) => {
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		seedPlaylistWithSongs(userId, playlistId, 'Row Menu Playlist', 2);

		await page.goto(`/library/${playlistId}`);

		await expect(page.getByRole('menuitem', { name: 'Add to queue' })).toHaveCount(0);

		await page.getByRole('button', { name: 'Song options' }).first().click();
		await expect(page.getByRole('menuitem', { name: 'Add to queue' })).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(page.getByRole('menuitem', { name: 'Add to queue' })).toHaveCount(0);
	});

	test('removes a song from the playlist', async ({ page }) => {
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		const tracks = seedPlaylistWithSongs(userId, playlistId, 'Removable Playlist', 2);

		await page.goto(`/library/${playlistId}`);
		const row = page.locator('li', { hasText: tracks[0].title });
		await row.hover();
		await row.getByRole('button').last().click();
		await page.getByRole('menuitem', { name: 'Remove from playlist' }).click();
		await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
		await expect(page.getByRole('dialog')).toBeHidden();

		await expect(page.locator('li', { hasText: tracks[0].title })).toBeHidden();
		await expect(page.getByText(tracks[1].title)).toBeVisible();
	});
});

test.describe('player bar', () => {
	test('starts playing the clicked track and shows it as the current track', async ({ page }) => {
		await stubStreamUrls(page);
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		const tracks = seedPlaylistWithSongs(userId, playlistId, 'Playback Test Playlist', 3);

		await page.goto(`/library/${playlistId}`);
		await page.getByRole('button', { name: 'Play' }).first().click();

		await expect(page.getByText(tracks[0].title)).toHaveCount(2); // list row + player bar
		await expect(page.getByRole('button', { name: 'Pause' }).last()).toBeVisible();
	});

	test('advances to the next track and back to the previous one', async ({ page }) => {
		await stubStreamUrls(page);
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		const tracks = seedPlaylistWithSongs(userId, playlistId, 'Skip Test Playlist', 3);

		await page.goto(`/library/${playlistId}`);
		await page.getByRole('button', { name: 'Play' }).first().click();
		await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();

		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.locator('p.text-sm.font-medium', { hasText: tracks[1].title })).toBeVisible();

		await page.getByRole('button', { name: 'Previous' }).click();
		await expect(page.locator('p.text-sm.font-medium', { hasText: tracks[0].title })).toBeVisible();
	});

	test('the previous button is disabled on the first track and next is disabled on the last (repeat off)', async ({
		page
	}) => {
		await stubStreamUrls(page);
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		seedPlaylistWithSongs(userId, playlistId, 'Boundary Test Playlist', 2);

		await page.goto(`/library/${playlistId}`);
		await page.getByRole('button', { name: 'Play' }).first().click();

		await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
	});

	test('persists across client-side navigation back to the library', async ({ page }) => {
		await stubStreamUrls(page);
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		const tracks = seedPlaylistWithSongs(userId, playlistId, 'Persistence Test Playlist', 1);

		await page.goto(`/library/${playlistId}`);
		await page.getByRole('button', { name: 'Play' }).first().click();
		await expect(page.getByRole('button', { name: 'Pause' }).last()).toBeVisible();

		await page.getByRole('link', { name: 'Library' }).first().click();
		await expect(page).toHaveURL('/library');
		await expect(page.locator('p.text-sm.font-medium', { hasText: tracks[0].title })).toBeVisible();
	});
});
