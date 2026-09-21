import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear()
});

async function freshStore() {
	vi.resetModules();
	return (await import('./cache-settings.svelte')).cacheSettings;
}

beforeEach(() => store.clear());

describe('auto cache', () => {
	it('defaults to on, so the behaviour that predates the setting is kept', async () => {
		expect((await freshStore()).autoCache).toBe(true);
	});

	it('remembers being turned off', async () => {
		(await freshStore()).setAutoCache(false);
		expect((await freshStore()).autoCache).toBe(false);
	});
});

describe('cache limit', () => {
	it('defaults to 2 GB', async () => {
		expect((await freshStore()).limitBytes).toBe(2_000_000_000);
	});

	it('remembers an explicit choice', async () => {
		(await freshStore()).setLimitBytes(5_000_000_000);
		expect((await freshStore()).limitBytes).toBe(5_000_000_000);
	});

	it('round-trips "no limit" as null rather than as a number', async () => {
		(await freshStore()).setLimitBytes(null);
		expect((await freshStore()).limitBytes).toBeNull();
	});

	it('falls back to the default for a corrupted value', async () => {
		// Reading this as 0 would mean "evict everything immediately".
		store.set('krsz-music:cache-limit-bytes', 'garbage');
		expect((await freshStore()).limitBytes).toBe(2_000_000_000);
	});

	it('falls back to the default for a zero or negative value', async () => {
		store.set('krsz-music:cache-limit-bytes', '0');
		expect((await freshStore()).limitBytes).toBe(2_000_000_000);
	});
});
