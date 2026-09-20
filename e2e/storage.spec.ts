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

/** Registers a user and gives them a playlist, returning the seeded tracks. */
async function setUpLibrary(page: Page, name: string, trackCount: number) {
	const { userId } = await registerViaApi(page);
	const playlistId = `e2e-playlist-${uniqueSuffix()}`;
	return seedPlaylistWithSongs(userId, playlistId, name, trackCount);
}

test.describe('manage storage page', () => {
	test('shows an empty state with no songs', async ({ page }) => {
		await registerViaApi(page);

		await page.goto('/settings/storage');

		await expect(page.getByText('No songs in your library yet.')).toBeVisible();
	});

	test('lists every song in the library with its file size', async ({ page }) => {
		const tracks = await setUpLibrary(page, 'Storage Test Playlist', 2);

		await page.goto('/settings/storage');

		await expect(page.getByText(tracks[0].title)).toBeVisible();
		await expect(page.getByText(tracks[1].title)).toBeVisible();
		// The seeded file_size_bytes (2000) is what this page exists to report,
		// and it is the one field the shared row renders only for this page.
		await expect(page.getByText('2.0 KB').first()).toBeVisible();
	});

	test('search narrows the list to matching titles', async ({ page }) => {
		const tracks = await setUpLibrary(page, 'Search Test Playlist', 2);

		await page.goto('/settings/storage');
		await page.getByPlaceholder('Search songs…').fill(tracks[0].title);

		await expect(page.getByText(tracks[0].title)).toBeVisible();
		await expect(page.getByText(tracks[1].title)).toHaveCount(0);
	});

	test('reports when a search matches nothing', async ({ page }) => {
		await setUpLibrary(page, 'No Match Playlist', 1);

		await page.goto('/settings/storage');
		await page.getByPlaceholder('Search songs…').fill('definitely-not-a-title');

		await expect(page.getByText('No songs match "definitely-not-a-title".')).toBeVisible();
	});

	test('selecting a song reveals the batch bar without moving the row under the pointer', async ({
		page
	}) => {
		const tracks = await setUpLibrary(page, 'Selection Test Playlist', 3);

		await page.goto('/settings/storage');
		const secondRow = page.getByText(tracks[1].title);
		await expect(secondRow).toBeVisible();

		const before = await secondRow.boundingBox();
		await page.getByText(tracks[0].title).click();
		await expect(page.getByText('1 selected')).toBeVisible();
		const after = await secondRow.boundingBox();

		// The batch bar overlays the list rather than taking layout space; if it
		// pushed the rows down, a second click would land on a different song.
		expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
	});

	test('select all selects every song, and clearing puts the bar away', async ({ page }) => {
		await setUpLibrary(page, 'Select All Playlist', 3);

		await page.goto('/settings/storage');
		await page.getByRole('button', { name: 'Select all' }).click();

		await expect(page.getByText('3 selected')).toBeVisible();

		await page.getByRole('button', { name: 'Clear selection' }).click();
		await expect(page.getByText('3 selected')).toHaveCount(0);
	});

	test('ctrl-clicking a second song adds it to the selection', async ({ page }) => {
		const tracks = await setUpLibrary(page, 'Multi Select Playlist', 3);

		await page.goto('/settings/storage');
		await page.getByText(tracks[0].title).click();
		await page.getByText(tracks[2].title).click({ modifiers: ['ControlOrMeta'] });

		await expect(page.getByText('2 selected')).toBeVisible();
	});

	test('shift-clicking selects the span shown between the two clicks', async ({ page }) => {
		const tracks = await setUpLibrary(page, 'Shift Select Playlist', 3);

		await page.goto('/settings/storage');
		await page.getByText(tracks[0].title).click();
		await page.getByText(tracks[2].title).click({ modifiers: ['Shift'] });

		await expect(page.getByText('3 selected')).toBeVisible();
	});

	test('the downloaded-only filter hides songs that are not cached', async ({ page }) => {
		const tracks = await setUpLibrary(page, 'Cached Filter Playlist', 2);

		await page.goto('/settings/storage');
		await expect(page.getByText(tracks[0].title)).toBeVisible();

		// Nothing has been downloaded, so this filter should empty the list.
		await page.getByRole('button', { name: 'Downloaded only' }).click();

		await expect(page.getByText('No songs match the current filters.')).toBeVisible();
	});

	test('sorting by title reorders the list', async ({ page }) => {
		await setUpLibrary(page, 'Sort Test Playlist', 3);

		await page.goto('/settings/storage');
		// On a phone the sort and filter controls start collapsed behind a
		// toggle, so the list isn't crowded out; open it before reaching for
		// them. The toggle isn't rendered at all from `sm:` up.
		const collapseToggle = page.getByRole('button', { name: /Sort & filter/ });
		if (await collapseToggle.isVisible()) await collapseToggle.click();

		// Default is file size; every seeded song shares one, so switch to a
		// field that actually distinguishes them. The direction carries over
		// from the file-size default, which starts on "largest first".
		await page.getByRole('button', { name: 'File size' }).click();
		await page.getByRole('option', { name: 'Title' }).click();

		const descending = await page.getByText(/^E2E Track \d+$/).allTextContents();
		expect(descending).toEqual([...descending].sort().reverse());

		await page.getByRole('button', { name: 'Sort descending' }).click();

		const ascending = await page.getByText(/^E2E Track \d+$/).allTextContents();
		expect(ascending).toEqual([...ascending].sort());
	});

	test('account storage usage is reported', async ({ page }) => {
		await setUpLibrary(page, 'Usage Playlist', 2);

		await page.goto('/settings/storage');

		await expect(page.getByText('Account storage (cloud)')).toBeVisible();
		await expect(page.getByText('Browser offline cache (this device)')).toBeVisible();
	});
});
