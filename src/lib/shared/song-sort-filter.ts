export type SongSortField =
	| 'custom'
	| 'title'
	| 'artist'
	| 'duration'
	| 'addedAt'
	| 'fileSize'
	| 'playCount'
	| 'lastPlayedAt';
export type SortDirection = 'asc' | 'desc';

export interface SongSortFilterInput {
	videoId: string;
	title: string;
	artist?: string | null;
	durationSeconds: number | null;
	addedAt?: string | null;
	/** Storage-page fields; absent on lists that don't sort by them. */
	fileSizeBytes?: number;
	playCount?: number;
	lastPlayedAt?: string | null;
}

export interface DurationRangeFilter {
	minSeconds: number | null;
	maxSeconds: number | null;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

/**
 * `custom` means "leave the input order alone" — it's the playlist's own
 * drag-to-reorder position, which isn't a field on the song itself and
 * can't be recovered by comparing two songs in isolation.
 */
export function compareSongs<T extends SongSortFilterInput>(
	a: T,
	b: T,
	field: SongSortField,
	direction: SortDirection
): number {
	if (field === 'custom') return 0;

	let cmp: number;
	switch (field) {
		case 'title':
			cmp = collator.compare(a.title, b.title);
			break;
		case 'artist':
			cmp = collator.compare(a.artist ?? '', b.artist ?? '');
			break;
		case 'duration':
			cmp = (a.durationSeconds ?? -1) - (b.durationSeconds ?? -1);
			break;
		case 'addedAt':
			cmp = (a.addedAt ?? '').localeCompare(b.addedAt ?? '');
			break;
		case 'fileSize':
			cmp = (a.fileSizeBytes ?? 0) - (b.fileSizeBytes ?? 0);
			break;
		case 'playCount':
			cmp = (a.playCount ?? 0) - (b.playCount ?? 0);
			break;
		case 'lastPlayedAt':
			// Never-played sorts last in both directions rather than as an
			// earliest date: "not comparable" is the honest reading of null
			// here, and burying unplayed songs under the oldest played ones
			// would be misleading either way round.
			if (!a.lastPlayedAt && !b.lastPlayedAt) return 0;
			if (!a.lastPlayedAt) return 1;
			if (!b.lastPlayedAt) return -1;
			cmp = a.lastPlayedAt.localeCompare(b.lastPlayedAt);
			break;
	}
	return direction === 'asc' ? cmp : -cmp;
}

export function sortSongs<T extends SongSortFilterInput>(
	songs: T[],
	field: SongSortField,
	direction: SortDirection
): T[] {
	if (field === 'custom') return songs;
	return [...songs].sort((a, b) => compareSongs(a, b, field, direction));
}

/** Same sort, applied to indices into `songs` rather than the array itself — for callers (e.g. drag-to-reorder) that need to keep operating on real array positions. */
export function sortIndices<T extends SongSortFilterInput>(
	songs: T[],
	indices: number[],
	field: SongSortField,
	direction: SortDirection
): number[] {
	if (field === 'custom') return indices;
	return [...indices].sort((ia, ib) => compareSongs(songs[ia], songs[ib], field, direction));
}

export function matchesDurationRange(durationSeconds: number | null, range: DurationRangeFilter): boolean {
	if (range.minSeconds === null && range.maxSeconds === null) return true;
	if (durationSeconds === null) return false;
	if (range.minSeconds !== null && durationSeconds < range.minSeconds) return false;
	if (range.maxSeconds !== null && durationSeconds > range.maxSeconds) return false;
	return true;
}
