import type { RepeatMode } from '$lib/shared/queue';

/**
 * Reading and writing the player's browser-local state.
 *
 * Split out of the player so it can be tested: the player itself constructs
 * an `Audio` element and registers document listeners the moment it is
 * imported, so nothing inside it can be exercised without a DOM. Everything
 * here is plain string↔object work, and it is the part that decides whether a
 * reload lands the reader back where they were.
 */

export interface PersistedTrack {
	videoId: string;
	title: string;
	durationSeconds: number | null;
}

export interface PersistedSession {
	queue: PersistedTrack[];
	queueIndex: number;
	shuffleEnabled: boolean;
	shuffleIndices: number[];
	repeatMode: RepeatMode;
	currentTimeSeconds: number;
}

export const VOLUME_STORAGE_KEY = 'krsz-music:volume';
export const SESSION_STORAGE_KEY = 'krsz-music:player-session';

/**
 * Volume as a 0–1 fraction, defaulting to full.
 *
 * Clamped rather than trusted: the value is user-writable storage, and a
 * number outside the range would either mute the player permanently or be
 * rejected by the media element.
 */
export function parseStoredVolume(raw: string | null): number {
	// An empty entry is absent data, not "volume zero" — Number('') is 0, so
	// without this a truncated write would silently mute the player with no
	// way for the reader to tell why.
	if (raw === null || raw.trim() === '') return 1;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
}

/**
 * A stored session, or null if there isn't a usable one.
 *
 * Every field is checked rather than cast. This is data the reader's own
 * browser holds across deploys, so it can predate a field, or be hand-edited,
 * or be a truncated write — and a restore that half-succeeds would leave the
 * player pointing at a track that isn't in its queue.
 */
export function parseStoredSession(raw: string | null): PersistedSession | null {
	if (raw === null) return null;
	let parsed: Partial<PersistedSession>;
	try {
		parsed = JSON.parse(raw) as Partial<PersistedSession>;
	} catch {
		return null;
	}
	if (!Array.isArray(parsed.queue) || typeof parsed.queueIndex !== 'number') return null;
	// An index outside the queue would make currentTrack undefined and leave
	// the player loaded but unplayable, so this is treated as no session at
	// all rather than a session to repair.
	if (parsed.queueIndex < 0 || parsed.queueIndex >= parsed.queue.length) return null;

	return {
		queue: parsed.queue,
		queueIndex: parsed.queueIndex,
		shuffleEnabled: parsed.shuffleEnabled === true,
		shuffleIndices: Array.isArray(parsed.shuffleIndices) ? parsed.shuffleIndices : [],
		repeatMode:
			parsed.repeatMode === 'one' || parsed.repeatMode === 'all' ? parsed.repeatMode : 'off',
		currentTimeSeconds:
			typeof parsed.currentTimeSeconds === 'number' && Number.isFinite(parsed.currentTimeSeconds)
				? Math.max(0, parsed.currentTimeSeconds)
				: 0
	};
}

/** Reads the stored session, or null when storage is unavailable or empty. */
export function readStoredSession(): PersistedSession | null {
	if (typeof localStorage === 'undefined') return null;
	return parseStoredSession(localStorage.getItem(SESSION_STORAGE_KEY));
}

/** Reads the stored volume, or 1 when storage is unavailable. */
export function readStoredVolume(): number {
	if (typeof localStorage === 'undefined') return 1;
	return parseStoredVolume(localStorage.getItem(VOLUME_STORAGE_KEY));
}

/** Persists a session, or clears the stored one when the queue is empty. */
export function writeStoredSession(session: PersistedSession | null): void {
	if (typeof localStorage === 'undefined') return;
	if (!session || session.queue.length === 0) {
		localStorage.removeItem(SESSION_STORAGE_KEY);
		return;
	}
	localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

/** Persists the volume. */
export function writeStoredVolume(volume: number): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(VOLUME_STORAGE_KEY, String(volume));
}
