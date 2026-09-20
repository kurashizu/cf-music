/**
 * Publishes what is playing to the operating system.
 *
 * On Android this is what puts the track in the notification shade and on the
 * lock screen, with working transport buttons; the same metadata drives
 * macOS's Now Playing and the hardware media keys. Without it the OS knows
 * only that some tab is making noise, which is why a backgrounded phone
 * offered no way to skip or pause without reopening the app.
 *
 * Deliberately a plain module the player calls, not something that reads the
 * player itself: the player owns playback, this owns one browser API, and
 * neither needs to know how the other works. Every entry point is a no-op
 * where the API is missing (Safari on iOS below 15, most desktop Firefox
 * builds), so callers never have to check.
 */

export interface MediaSessionTrack {
	title: string;
	artist?: string | null;
	album?: string | null;
	artworkUrl?: string | null;
}

export interface MediaSessionHandlers {
	onPlay: () => void;
	onPause: () => void;
	onPreviousTrack: () => void;
	onNextTrack: () => void;
	onSeekTo: (seconds: number) => void;
	onSeekBackward: (offsetSeconds: number) => void;
	onSeekForward: (offsetSeconds: number) => void;
	onStop: () => void;
}

function mediaSession(): MediaSession | null {
	if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null;
	return navigator.mediaSession;
}

/** How far the OS's skip-back/skip-forward buttons move, when it shows them. */
const SEEK_OFFSET_SECONDS = 10;

/**
 * Registers the transport controls the OS surfaces.
 *
 * Called once, not per track: the handlers close over the player, so
 * re-registering on every track change would only churn the same callbacks.
 * Each is set individually because a browser that doesn't understand one
 * action throws for that action alone, and losing the rest with it would be
 * worse than skipping the one.
 */
export function bindMediaSessionHandlers(handlers: MediaSessionHandlers): void {
	const session = mediaSession();
	if (!session) return;

	const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
		['play', () => handlers.onPlay()],
		['pause', () => handlers.onPause()],
		['previoustrack', () => handlers.onPreviousTrack()],
		['nexttrack', () => handlers.onNextTrack()],
		['stop', () => handlers.onStop()],
		[
			'seekbackward',
			(details) => handlers.onSeekBackward(details.seekOffset ?? SEEK_OFFSET_SECONDS)
		],
		['seekforward', (details) => handlers.onSeekForward(details.seekOffset ?? SEEK_OFFSET_SECONDS)],
		[
			'seekto',
			(details) => {
				if (typeof details.seekTime === 'number') handlers.onSeekTo(details.seekTime);
			}
		]
	];

	for (const [action, handler] of actions) {
		try {
			session.setActionHandler(action, handler);
		} catch {
			// This browser doesn't support this action; the others still work.
		}
	}
}

/**
 * Describes the current track to the OS.
 *
 * `artworkUrl` may be a blob URL — the covers this app displays are fetched
 * and cached as blobs (see image-throttle), and a blob URL works here, which
 * is what lets artwork appear in the notification with no network.
 */
export function setMediaSessionTrack(track: MediaSessionTrack | null): void {
	const session = mediaSession();
	if (!session) return;

	if (!track) {
		session.metadata = null;
		return;
	}

	try {
		session.metadata = new MediaMetadata({
			title: track.title,
			artist: track.artist ?? '',
			album: track.album ?? '',
			artwork: track.artworkUrl
				? [{ src: track.artworkUrl, sizes: '512x512', type: 'image/webp' }]
				: []
		});
	} catch {
		// MediaMetadata is unavailable even though mediaSession exists on a
		// few older builds; the transport handlers above still work.
	}
}

/** Tells the OS whether to draw a play or a pause button. */
export function setMediaSessionPlaybackState(isPlaying: boolean): void {
	const session = mediaSession();
	if (!session) return;
	session.playbackState = isPlaying ? 'playing' : 'paused';
}

/**
 * Keeps the OS's scrubber in step with playback.
 *
 * Guarded because the spec rejects anything inconsistent — a position past
 * the duration, a duration that isn't a finite number yet (it isn't, until
 * metadata loads) — and a throw here would break the update loop it is
 * called from.
 */
export function setMediaSessionPosition(
	positionSeconds: number,
	durationSeconds: number,
	playbackRate = 1
): void {
	const session = mediaSession();
	if (!session || typeof session.setPositionState !== 'function') return;
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;

	try {
		session.setPositionState({
			duration: durationSeconds,
			playbackRate: playbackRate > 0 ? playbackRate : 1,
			position: Math.min(Math.max(positionSeconds, 0), durationSeconds)
		});
	} catch {
		// An inconsistent position/duration pair mid-track-change; the next
		// timeupdate corrects it.
	}
}

/** Clears everything, so the OS stops showing a track once nothing is loaded. */
export function clearMediaSession(): void {
	const session = mediaSession();
	if (!session) return;
	session.metadata = null;
	session.playbackState = 'none';
}
