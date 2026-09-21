import type { PlayStat } from './cache-limit';

/**
 * This user's play history from the server.
 *
 * Returns nothing on any failure rather than throwing: its only caller is
 * the cache limit, and an empty history there means every cached song
 * ranks as never-played, so enforceCacheLimit skips the round rather than
 * evicting on no information. Failing closed keeps a network blip from
 * deleting the wrong songs.
 */
export async function fetchPlayStats(): Promise<PlayStat[]> {
	try {
		const response = await fetch('/api/play-stats');
		if (!response.ok) return [];
		return (await response.json()) as PlayStat[];
	} catch {
		return [];
	}
}
