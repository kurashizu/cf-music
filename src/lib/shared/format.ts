/**
 * Formatting shared by every view that lists songs.
 *
 * These were previously copied into each page, which is how the same duration
 * ended up rendered three slightly different ways depending on where you
 * looked at it.
 */

/** `m:ss`, or an em dash when the duration isn't known. */
export function formatDuration(seconds: number | null): string {
	if (seconds === null) return '—';
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.floor(seconds % 60);
	return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

/**
 * `m:ss` for a playback position, which is always a real number of seconds.
 *
 * Separate from formatDuration because a position has no "unknown" case — it
 * is 0 before anything loads, never null — and a clock that reads an em dash
 * while a track is playing would be wrong. A not-yet-known duration arrives
 * here as NaN from the media element, which reads as 0:00.
 */
export function formatPlaybackTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.floor(seconds % 60);
	return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

/** `h:mm:ss` for spans long enough that minutes alone stop being readable. */
export function formatLongDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = Math.floor(totalSeconds % 60);
	if (hours === 0) return `${minutes}:${seconds.toString().padStart(2, '0')}`;
	return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * `2h 15m` — a rough total, where seconds would be noise.
 *
 * Distinct from formatLongDuration: that one is a timeline figure read
 * precisely, this one answers "how much music is this" at a glance.
 */
export function formatCompactDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

/**
 * Parses SQLite's own `current_timestamp` format ("YYYY-MM-DD HH:MM:SS") as
 * well as ISO strings. That format is UTC but carries no zone marker, and
 * `new Date()` reads a zoneless date-time as local time — so without the
 * "Z" every column defaulting to current_timestamp would be off by the
 * reader's UTC offset.
 */
function parseTimestamp(timestamp: string): Date {
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)
		? timestamp.replace(' ', 'T') + 'Z'
		: timestamp;
	return new Date(iso);
}

/** A timestamp in the reader's own locale and timezone. */
export function formatDateTime(timestamp: string): string {
	return parseTimestamp(timestamp).toLocaleString();
}

const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 365 * 24 * 60 * 60],
	['month', 30 * 24 * 60 * 60],
	['week', 7 * 24 * 60 * 60],
	['day', 24 * 60 * 60],
	['hour', 60 * 60],
	['minute', 60]
];
const relativeTimeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** How long ago a timestamp was — "3 hours ago", "yesterday" — or "just now" under a minute. */
export function formatRelativeTime(timestamp: string, now: Date = new Date()): string {
	const elapsedSeconds = (now.getTime() - parseTimestamp(timestamp).getTime()) / 1000;
	for (const [unit, seconds] of RELATIVE_TIME_UNITS) {
		if (elapsedSeconds >= seconds) {
			return relativeTimeFormat.format(-Math.floor(elapsedSeconds / seconds), unit);
		}
	}
	return 'just now';
}

/** `codec · Nkbps`, dropping the bitrate when it isn't recorded. */
export function formatAudioSpec(codec: string | null, bitrateKbps: number | null): string {
	if (!codec) return '';
	return bitrateKbps ? `${codec} · ${bitrateKbps}kbps` : codec;
}

/** Byte counts at the precision a storage figure is actually read at. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB'];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}
