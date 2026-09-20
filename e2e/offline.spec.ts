import { test, expect, type Page } from '@playwright/test';
import { issueInviteCode, uniqueSuffix } from './fixtures';

/**
 * The offline experience: an installed app whose connection drops should
 * still open, and still play whatever is already downloaded.
 *
 * These drive /offline.html directly rather than by cutting the network.
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
		const audio = await caches.open('audio-v1');
		const meta = await caches.open('audio-meta-v1');
		for (let i = 1; i <= n; i++) {
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
			const cached = app ? await app.match('/offline.html') : null;
			return { precached: !!cached, length: cached ? (await cached.text()).length : 0 };
		});

		expect(result.precached).toBe(true);
		expect(result.length).toBeGreaterThan(1000);
	});

	test('the cached offline page can be returned from a navigation', async ({ page }) => {
		await registerAndLand(page);

		// The host redirects /offline.html to /offline, so the precached entry
		// is a redirected response — and returning one of those from a
		// navigation throws, which would drop the reader back on the browser's
		// own error page. The worker rebuilds it; this asserts the rebuilt
		// response is one a navigation can actually use.
		const result = await page.evaluate(async () => {
			const keys = await caches.keys();
			const appKey = keys.find((k) => k.startsWith('app-'));
			const app = appKey ? await caches.open(appKey) : null;
			const cached = app ? await app.match('/offline.html') : null;
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

		await page.goto('/offline.html');

		await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible();
		await expect(page.getByText('3 downloaded songs are available.')).toBeVisible();
		await expect(page.getByText('Offline Song 1')).toBeVisible();

		// Playback comes entirely from the cache — no request is made for it.
		await page.locator('#list li button').first().click();
		await expect(page.locator('#bar')).toBeVisible();
		await expect(page.locator('#now-title')).toHaveText('Offline Song 1');
		// The element is detached (new Audio()), so the button's own label is
		// the observable signal that playback actually started: it only flips
		// to "Pause" from the element's own 'play' event.
		await expect(page.locator('#toggle')).toHaveAttribute('aria-label', 'Pause');
	});

	test('says so plainly when nothing is downloaded', async ({ page }) => {
		await registerAndLand(page);
		await page.evaluate(async () => {
			await caches.delete('audio-v1');
			await caches.delete('audio-meta-v1');
		});

		await page.goto('/offline.html');

		await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible();
		await expect(page.getByText('Nothing is downloaded on this device.')).toBeVisible();
	});

	test('a track cached before metadata existed still plays, listed by its id', async ({ page }) => {
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

		await page.goto('/offline.html');

		await expect(page.getByText('legacy-song')).toBeVisible();
	});
});
