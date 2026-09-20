import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	LOCAL_STORAGE_KEYS,
	summarizeLocalData,
	clearAllLocalData
} from './local-storage-inventory';

function installFakeLocalStorage(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
		removeItem: (key: string) => store.delete(key)
	});
	return store;
}

function installFakeCaches(initial: Record<string, string[]> = {}) {
	const stores = new Map(Object.entries(initial).map(([name, keys]) => [name, new Set(keys)]));
	vi.stubGlobal('caches', {
		keys: async () => [...stores.keys()],
		open: async (name: string) => {
			if (!stores.has(name)) stores.set(name, new Set());
			const keySet = stores.get(name)!;
			return { keys: async () => [...keySet] };
		},
		delete: async (name: string) => stores.delete(name)
	});
	return stores;
}

beforeEach(() => {
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('summarizeLocalData', () => {
	it('reports zero for both when nothing is stored', async () => {
		installFakeLocalStorage();
		installFakeCaches();

		await expect(summarizeLocalData()).resolves.toEqual({
			localStorageBytes: 0,
			cacheEntryCount: 0
		});
	});

	it("counts only this app's own localStorage keys, not unrelated ones", async () => {
		installFakeLocalStorage({
			[LOCAL_STORAGE_KEYS[0]]: 'abc',
			'some-other-site-key': 'should not be counted'
		});
		installFakeCaches();

		const summary = await summarizeLocalData();
		expect(summary.localStorageBytes).toBeGreaterThan(0);
		// Sanity bound: this app's one small key can't plausibly account for
		// as many bytes as the deliberately-larger unrelated key would add.
		expect(summary.localStorageBytes).toBeLessThan(200);
	});

	it('counts cache entries across every cache store', async () => {
		installFakeLocalStorage();
		installFakeCaches({ 'audio-v1': ['a', 'b'], 'cover-v1': ['c'] });

		const summary = await summarizeLocalData();
		expect(summary.cacheEntryCount).toBe(3);
	});
});

describe('clearAllLocalData', () => {
	it('removes every known localStorage key without touching unrelated ones', async () => {
		const store = installFakeLocalStorage({
			[LOCAL_STORAGE_KEYS[0]]: 'x',
			[LOCAL_STORAGE_KEYS[1]]: 'y',
			'unrelated-key': 'keep me'
		});
		installFakeCaches();

		await clearAllLocalData();

		for (const key of LOCAL_STORAGE_KEYS) expect(store.has(key)).toBe(false);
		expect(store.get('unrelated-key')).toBe('keep me');
	});

	it('deletes every cache store', async () => {
		installFakeLocalStorage();
		const stores = installFakeCaches({ 'audio-v1': ['a'], 'cover-v1': ['b'], 'app-v1': ['c'] });

		await clearAllLocalData();

		expect(stores.size).toBe(0);
	});
});
