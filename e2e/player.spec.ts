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

// "Play" is a substring of the sidebar's "Collapse playlists" button, so an
// unscoped getByRole('button', { name: 'Play' }) matches it too — and
// .first() picked it, clicking the sidebar toggle instead of anything that
// plays. Every player control below is scoped to the element that owns it
// and matched exactly.
/**
 * Clicks the first song row's play button, once it is actually interactive.
 *
 * The page server-renders the rows, so a click can land before hydration has
 * attached the handler — the button is present and clickable but nothing
 * happens, leaving the player at "Nothing playing". Waiting for the player
 * bar to leave its empty state confirms the click took effect rather than
 * being swallowed.
 */
async function playFirstRow(page: Page) {
	const button = page.locator('main li button[aria-label="Play"]').first();
	await expect(button).toBeVisible();
	await expect(async () => {
		await button.click();
		await expect(page.getByText('Nothing playing')).toHaveCount(0, { timeout: 2000 });
	}).toPass({ timeout: 20000 });
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

		const menuItem = page.getByRole('menuitem', { name: 'Add to queue' });
		await expect(menuItem).toHaveCount(0);

		// Wait for the row itself before reaching for its menu: under a loaded
		// test server the list can still be rendering, and clicking a trigger
		// mid-render opened nothing.
		const trigger = page.getByRole('button', { name: 'Song options' }).first();
		await expect(trigger).toBeVisible();
		await trigger.click();
		await expect(menuItem).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(menuItem).toHaveCount(0);
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

test.describe('library index', () => {
	test('renders playlist cards, including the empty-cover fallback', async ({ page }) => {
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		seedPlaylistWithSongs(userId, playlistId, 'Card Render Playlist', 2);

		await page.goto('/library');

		// The shared PlaylistCard draws its no-covers icon through a snippet.
		// Naming that snippet the same as the prop it renders made it recurse
		// into itself until the render stack blew — a 500 that both typecheck
		// and every other test missed, because nothing else rendered this page
		// with a coverless playlist.
		// Scoped to the grid: the sidebar lists the same playlist by name.
		await expect(
			page.locator('main').getByRole('link', { name: /Card Render Playlist/ })
		).toBeVisible();
		await expect(page.locator('main').getByText('2 songs')).toBeVisible();
		await expect(page.getByText('500')).toHaveCount(0);
	});
});

test.describe('player bar', () => {
	test('starts playing the clicked track and shows it as the current track', async ({ page }) => {
		await stubStreamUrls(page);
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		const tracks = seedPlaylistWithSongs(userId, playlistId, 'Playback Test Playlist', 3);

		await page.goto(`/library/${playlistId}`);
		await playFirstRow(page);

		await expect(page.getByText(tracks[0].title)).toHaveCount(2); // list row + player bar
		await expect(page.getByRole('button', { name: 'Pause', exact: true }).last()).toBeVisible();
	});

	test('advances to the next track and back to the previous one', async ({ page }) => {
		await stubStreamUrls(page);
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		const tracks = seedPlaylistWithSongs(userId, playlistId, 'Skip Test Playlist', 3);

		await page.goto(`/library/${playlistId}`);
		await playFirstRow(page);
		await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();

		await page.getByRole('button', { name: 'Next', exact: true }).click();
		await expect(page.locator('p.text-sm.font-medium', { hasText: tracks[1].title })).toBeVisible();

		await page.getByRole('button', { name: 'Previous', exact: true }).click();
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
		await playFirstRow(page);

		await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
		await page.getByRole('button', { name: 'Next', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
	});

	test('advances on its own when a track plays to its end', async ({ page }) => {
		await stubStreamUrls(page);
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		const tracks = seedPlaylistWithSongs(userId, playlistId, 'Natural End Playlist', 2);

		await page.goto(`/library/${playlistId}`);
		await playFirstRow(page);
		await expect(page.locator('p.text-sm.font-medium', { hasText: tracks[0].title })).toBeVisible();

		// The fixture is ~2s long, so this lets it finish rather than skipping.
		// A track ending pauses the element before firing 'ended'; treating
		// that pause as a lost output device used to reload the finished track
		// and seek back to its end, leaving the player stuck at "3:04 / 3:04"
		// with the progress bar jittering instead of moving on.
		await expect(page.locator('p.text-sm.font-medium', { hasText: tracks[1].title })).toBeVisible({
			timeout: 15000
		});
	});

	test('persists across client-side navigation back to the library', async ({ page }) => {
		await stubStreamUrls(page);
		const { userId } = await registerViaApi(page);
		const playlistId = `e2e-playlist-${uniqueSuffix()}`;
		const tracks = seedPlaylistWithSongs(userId, playlistId, 'Persistence Test Playlist', 1);

		await page.goto(`/library/${playlistId}`);
		await playFirstRow(page);
		await expect(page.getByRole('button', { name: 'Pause', exact: true }).last()).toBeVisible();

		await page.getByRole('link', { name: 'Library', exact: true }).first().click();
		await expect(page).toHaveURL('/library');
		await expect(page.locator('p.text-sm.font-medium', { hasText: tracks[0].title })).toBeVisible();
	});
});
