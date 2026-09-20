/**
 * Every localStorage key this app writes, in one place — each individual
 * store (player, view-mode, sidebar) owns reading/writing its own key, but
 * the Settings page's "clear local data" action needs the full list to
 * actually wipe it, and there's nowhere else that already enumerates all
 * of them.
 */
export const LOCAL_STORAGE_KEYS = [
	'krsz-music:volume',
	'krsz-music:player-session',
	'krsz-music:view-mode',
	'krsz-music:sidebar-collapsed',
	'krsz-music:trim-silence',
	// Measured per track, so this is the one key here that grows with the
	// library — it counts toward the reported size and is cleared with the
	// rest. The measurements are re-derived from cached audio on later plays.
	'krsz-music:trim-points'
] as const;

export interface LocalDataSummary {
	localStorageBytes: number;
	cacheEntryCount: number;
}

/** Rough byte size of this app's own localStorage keys — UTF-16 code units, same approximation the browser itself uses for quota accounting. */
function estimateLocalStorageBytes(): number {
	if (typeof localStorage === 'undefined') return 0;
	let total = 0;
	for (const key of LOCAL_STORAGE_KEYS) {
		const value = localStorage.getItem(key);
		if (value !== null) total += key.length + value.length;
	}
	return total * 2;
}

/** Summarizes what "clear local data" would actually remove, for the confirmation UI. */
export async function summarizeLocalData(): Promise<LocalDataSummary> {
	const localStorageBytes = estimateLocalStorageBytes();

	let cacheEntryCount = 0;
	if (typeof caches !== 'undefined') {
		const keys = await caches.keys();
		for (const key of keys) {
			const cache = await caches.open(key);
			cacheEntryCount += (await cache.keys()).length;
		}
	}

	return { localStorageBytes, cacheEntryCount };
}

/**
 * Removes every localStorage key this app owns and every Cache Storage
 * entry (audio, covers, and the app-shell precache — see
 * service-worker.ts) — everything the browser holds locally, but not
 * account storage in the cloud (that's the separate, explicit "Manage
 * storage" page). The service worker re-populates its app-shell cache on
 * its own the next time it activates, so this doesn't need to also
 * unregister it.
 */
export async function clearAllLocalData(): Promise<void> {
	if (typeof localStorage !== 'undefined') {
		for (const key of LOCAL_STORAGE_KEYS) localStorage.removeItem(key);
	}
	if (typeof caches !== 'undefined') {
		const keys = await caches.keys();
		await Promise.all(keys.map((key) => caches.delete(key)));
	}
}
