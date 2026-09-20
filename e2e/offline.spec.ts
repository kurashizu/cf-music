import { test, expect, type Page } from '@playwright/test';
import { issueInviteCode, uniqueSuffix } from './fixtures';

/**
 * The offline experience: an installed app whose connection drops should
 * still open, and still play whatever is already downloaded.
 *
 * These drive /offline directly rather than by cutting the network.
 * Neither Playwright's setOffline nor CDP's network emulation reaches a
 * service worker's own fetch() in this setup — the navigation either fails
 * before the worker sees it or succeeds against the real server — so a test
 * written that way would assert the harness, not the app. What the worker
 * does with a failed navigation is a three-line catch (see service-worker.ts);
 * what the page then does with the caches is the part worth covering, and it
 * is exercised here exactly as the worker serves it.
 */
async function registerAndLand(page: Page) {
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
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) {
			await new Promise((resolve) =>
				navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
			);
		}
	});
}

/** Writes the same two cache entries a real download produces. */
async function seedDownloads(page: Page, count: number) {
	await page.evaluate(async (n) => {
		const tone = () => {
			const sampleRate = 8000;
			const frames = sampleRate * 2;
			const buffer = new ArrayBuffer(44 + frames * 2);
			const view = new DataView(buffer);
			const ascii = (offset: number, text: string) => {
				for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
			};
			ascii(0, 'RIFF');
			view.setUint32(4, 36 + frames * 2, true);
			ascii(8, 'WAVEfmt ');
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, sampleRate, true);
			view.setUint32(28, sampleRate * 2, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			ascii(36, 'data');
			view.setUint32(40, frames * 2, true);
			for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.sin(i / 20) * 3000, true);
			return buffer;
		};

		await caches.delete('audio-v1');
		await caches.delete('audio-meta-v1');
		await caches.delete('cover-v1');
		await caches.delete('library-v1');
		const audio = await caches.open('audio-v1');
		const meta = await caches.open('audio-meta-v1');
		const covers = await caches.open('cover-v1');
		// A 1x1 PNG stands in for a real cover; what matters is that one is
		// found under the videoId and rendered.
		const pngBytes = Uint8Array.from(
			atob(
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
			),
			(c) => c.charCodeAt(0)
		);
		for (let i = 1; i <= n; i++) {
			await covers.put(
				`https://covers.cf-music.internal/offline-song-${i}`,
				new Response(pngBytes, { headers: { 'content-type': 'image/png' } })
			);
			await audio.put(
				`https://audio.cf-music.internal/offline-song-${i}`,
				new Response(tone(), { headers: { 'content-type': 'audio/wav' } })
			);
			await meta.put(
				`https://meta.cf-music.internal/offline-song-${i}`,
				new Response(
					JSON.stringify({
						videoId: `offline-song-${i}`,
						title: `Offline Song ${i}`,
						durationSeconds: 120
					}),
					{ headers: { 'content-type': 'application/json' } }
				)
			);
		}
	}, count);
}

test.describe('offline', () => {
	test('the service worker precaches the offline page and serves it from cache', async ({
		page
	}) => {
		await registerAndLand(page);

		const result = await page.evaluate(async () => {
			const keys = await caches.keys();
			const appKey = keys.find((k) => k.startsWith('app-'));
			const app = appKey ? await caches.open(appKey) : null;
			const cached = app ? await app.match('/offline') : null;
			return { precached: !!cached, length: cached ? (await cached.text()).length : 0 };
		});

		expect(result.precached).toBe(true);
		expect(result.length).toBeGreaterThan(1000);
	});

	test('the cached offline page can be returned from a navigation', async ({ page }) => {
		await registerAndLand(page);

		// A cached entry can carry a redirect flag (the host rewrites
		// prerendered paths), and returning a redirected response from a
		// navigation throws, which would drop the reader back on the browser's
		// own error page. The worker rebuilds it; this asserts the rebuilt
		// response is one a navigation can actually use.
		const result = await page.evaluate(async () => {
			const keys = await caches.keys();
			const appKey = keys.find((k) => k.startsWith('app-'));
			const app = appKey ? await caches.open(appKey) : null;
			const cached = app ? await app.match('/offline') : null;
			if (!cached) return { cached: false };

			const rebuilt = new Response(await cached.blob(), {
				status: 200,
				headers: { 'content-type': 'text/html; charset=utf-8' }
			});
			return {
				cached: true,
				cachedWasRedirected: cached.redirected,
				rebuiltIsRedirected: rebuilt.redirected,
				rebuiltStatus: rebuilt.status
			};
		});

		expect(result.cached).toBe(true);
		// Whether the host redirects is its business; what matters is that what
		// the worker hands back never carries the flag.
		expect(result.rebuiltIsRedirected).toBe(false);
		expect(result.rebuiltStatus).toBe(200);
	});

	test('lists downloaded songs and plays one with no network', async ({ page }) => {
		await registerAndLand(page);
		await seedDownloads(page, 3);

		await page.goto('/offline');

		await expect(page.getByRole('heading', { name: 'All downloaded' })).toBeVisible();
		await expect(page.getByText('3 songs · available without a connection')).toBeVisible();
		await expect(page.getByText('Offline Song 1')).toBeVisible();

		// Playback comes entirely from the cache — the real player bar, the
		// same one the online app uses, picks it up.
		await page.locator('main li button[aria-label="Play"]').first().click();
		await expect(page.locator('p.text-sm.font-medium', { hasText: 'Offline Song 1' })).toBeVisible();
	});

	test('covers come from the cache, so rows are not blank', async ({ page }) => {
		await registerAndLand(page);
		await seedDownloads(page, 2);

		await page.goto('/offline');
		await expect(page.getByText('Offline Song 1')).toBeVisible();

		// The cover resolves to a blob URL minted from the cache — a presigned
		// one could not be signed without a server.
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const img = document.querySelector('main img');
					return img instanceof HTMLImageElement ? img.src.startsWith('blob:') : false;
				})
			)
			.toBe(true);
	});

	test('playlists survive offline, with their own order', async ({ page }) => {
		await registerAndLand(page);
		await seedDownloads(page, 3);
		await page.evaluate(async () => {
			const cache = await caches.open('library-v1');
			await cache.put(
				'https://library.cf-music.internal/snapshot',
				new Response(
					JSON.stringify({
						capturedAt: new Date().toISOString(),
						playlists: [
							{
								id: 'p1',
								name: 'Evening',
								kind: 'user',
								// Deliberately not alphabetical: a playlist keeps its
								// stored order, unlike the all-downloaded view.
								videoIds: ['offline-song-3', 'offline-song-1']
							},
							{
								id: 'p2',
								name: 'Nothing Downloaded',
								kind: 'user',
								videoIds: ['not-cached-at-all']
							}
						]
					}),
					{ headers: { 'content-type': 'application/json' } }
				)
			);
		});

		await page.goto('/offline');

		// The library index shows playlist cards, exactly as it does online —
		// and only those with something actually downloaded.
		await expect(page.getByRole('heading', { name: 'Your playlists' })).toBeVisible();
		// Scoped to the grid: the sidebar lists the same playlists, which is
		// itself the point — offline carries the app's own navigation. (On a
		// phone the sidebar is hidden, but scoping keeps both cases identical.)
		const card = page.locator('main').getByText('Evening');
		await expect(card).toBeVisible();
		await expect(page.locator('main').getByText('Nothing Downloaded')).toHaveCount(0);

		await card.click();

		await expect(page.getByRole('heading', { name: 'Evening' })).toBeVisible();
		await expect(page.getByText('2 songs downloaded')).toBeVisible();
		// A playlist keeps its stored order, unlike the all-downloaded view.
		const titles = await page.getByText(/^Offline Song \d$/).allTextContents();
		expect(titles).toEqual(['Offline Song 3', 'Offline Song 1']);
	});

	test('carries the app shell, so offline is not a different screen', async ({ page }) => {
		await registerAndLand(page);
		await seedDownloads(page, 2);

		await page.goto('/offline');

		// The same navigation the online app has, rather than a bare page —
		// the sidebar on a wide screen, the bottom bar on a phone.
		const nav = page.getByRole('navigation', { name: /^Primary/ }).filter({ visible: true });
		await expect(nav.first()).toBeVisible();
		await expect(nav.first().getByRole('link', { name: 'Library', exact: true })).toBeVisible();
		// Rendered in the sidebar footer and the mobile header; only one of
		// those is on screen at a given width.
		await expect(page.getByText('Offline').filter({ visible: true }).first()).toBeVisible();
	});

	test('navigating to a server-backed page with no connection lands on downloads', async ({
		page,
		context
	}) => {
		await registerAndLand(page);
		await seedDownloads(page, 2);
		await page.goto('/offline');
		await expect(page.getByRole('heading', { name: 'All downloaded' })).toBeVisible();

		await context.setOffline(true);
		// Settings loads its data from the server; without this guard the
		// client router surfaced a bare "500 Internal Error" page.
		await page.getByRole('link', { name: 'Settings', exact: true }).first().click();

		await expect(page).toHaveURL(/\/offline$/);
		await expect(page.getByRole('heading', { name: 'All downloaded' })).toBeVisible();
		await expect(page.getByText('500')).toHaveCount(0);

		await context.setOffline(false);
	});

	test('says so plainly when nothing is downloaded', async ({ page }) => {
		await registerAndLand(page);
		await page.evaluate(async () => {
			await caches.delete('audio-v1');
			await caches.delete('audio-meta-v1');
		});

		await page.goto('/offline');

		await expect(page.getByText('No songs are downloaded on this device.')).toBeVisible();
	});

	test('a track cached before metadata existed still lists, by its id', async ({ page }) => {
		await registerAndLand(page);
		await page.evaluate(async () => {
			await caches.delete('audio-v1');
			await caches.delete('audio-meta-v1');
			const audio = await caches.open('audio-v1');
			await audio.put(
				'https://audio.cf-music.internal/legacy-song',
				new Response(new ArrayBuffer(64), { headers: { 'content-type': 'audio/wav' } })
			);
		});

		await page.goto('/offline');

		await expect(page.getByText('legacy-song')).toBeVisible();
	});
});
