const AUTO_CACHE_KEY = 'krsz-music:auto-cache';
const LIMIT_KEY = 'krsz-music:cache-limit-bytes';

/**
 * Cache limit choices, in bytes. `null` is "no limit" — the behaviour
 * this app had before the limit existed, kept as an explicit choice
 * rather than a hidden default.
 */
export const CACHE_LIMIT_OPTIONS: { label: string; bytes: number | null }[] = [
	{ label: '500 MB', bytes: 500_000_000 },
	{ label: '1 GB', bytes: 1_000_000_000 },
	{ label: '2 GB', bytes: 2_000_000_000 },
	{ label: '5 GB', bytes: 5_000_000_000 },
	{ label: '10 GB', bytes: 10_000_000_000 },
	{ label: 'No limit', bytes: null }
];

/**
 * Default limit. Two gigabytes holds roughly 1,200 songs at the ~139 kbps
 * this library actually averages — comfortably more than anyone plays
 * through in a stretch, while still bounded. Songs are re-fetched on
 * demand, so the cost of the limit being too low is a re-download, not
 * lost data.
 */
export const DEFAULT_CACHE_LIMIT_BYTES = 2_000_000_000;

function readAutoCache(): boolean {
	if (typeof localStorage === 'undefined') return true;
	// Absent means on: auto-caching predates this setting, so a user who
	// never touches it keeps the behaviour they already had.
	return localStorage.getItem(AUTO_CACHE_KEY) !== 'off';
}

function readLimit(): number | null {
	if (typeof localStorage === 'undefined') return DEFAULT_CACHE_LIMIT_BYTES;
	const raw = localStorage.getItem(LIMIT_KEY);
	if (raw === null) return DEFAULT_CACHE_LIMIT_BYTES;
	if (raw === 'none') return null;
	const parsed = Number(raw);
	// A blank or corrupted value reads as the default rather than as 0,
	// which would otherwise mean "evict everything immediately".
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_LIMIT_BYTES;
}

/**
 * Whether songs played through are kept for offline use, and how much
 * space those kept songs may occupy.
 *
 * Device-local like volume and skip-silence: it governs what this browser
 * stores, not anything about the library. Turning auto-cache off stops new
 * songs being kept; it deliberately does not delete what is already
 * cached, since that would throw away offline audio the user may be
 * relying on. Explicit downloads are unaffected by either setting — see
 * enforceCacheLimit for why they are never evicted automatically.
 */
class CacheSettingsStore {
	autoCache = $state<boolean>(readAutoCache());
	limitBytes = $state<number | null>(readLimit());

	setAutoCache(enabled: boolean): void {
		if (enabled === this.autoCache) return;
		this.autoCache = enabled;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(AUTO_CACHE_KEY, enabled ? 'on' : 'off');
		}
	}

	setLimitBytes(bytes: number | null): void {
		if (bytes === this.limitBytes) return;
		this.limitBytes = bytes;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(LIMIT_KEY, bytes === null ? 'none' : String(bytes));
		}
	}
}

export const cacheSettings = new CacheSettingsStore();
