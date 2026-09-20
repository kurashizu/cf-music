import { hasReachedPlayThreshold } from '$lib/shared/playback';
import { shuffleOrder, nextQueueIndex, cycleRepeatMode, moveIndexToFront, type RepeatMode } from '$lib/shared/queue';
import { precacheAudio } from '$lib/client/offline-cache';
import { silenceTrim, getTrimPoints, analyzeTrackIfCached } from '$lib/client/silence-trim.svelte';

export interface QueueTrack {
	videoId: string;
	title: string;
	durationSeconds: number | null;
}

interface StreamUrlResponse {
	audioUrl: string;
	coverUrl: string | null;
	expiresInSeconds: number;
	codec: string;
	bitrateKbps: number | null;
	sampleRate: number | null;
}

export interface AudioSpec {
	codec: string;
	bitrateKbps: number | null;
	sampleRate: number | null;
}

const VOLUME_STORAGE_KEY = 'krsz-music:volume';
const SESSION_STORAGE_KEY = 'krsz-music:player-session';
// Rewriting localStorage on every timeupdate (multiple times/second) would
// be wasteful for a value only ever read back after a full page reload —
// this bounds how often the position actually gets persisted.
const SESSION_SAVE_INTERVAL_MS = 5000;

function readStoredVolume(): number {
	if (typeof localStorage === 'undefined') return 1;
	const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
	if (raw === null) return 1;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
}

interface PersistedSession {
	queue: QueueTrack[];
	queueIndex: number;
	shuffleEnabled: boolean;
	shuffleIndices: number[];
	repeatMode: RepeatMode;
	currentTimeSeconds: number;
}

function readStoredSession(): PersistedSession | null {
	if (typeof localStorage === 'undefined') return null;
	const raw = localStorage.getItem(SESSION_STORAGE_KEY);
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<PersistedSession>;
		if (!Array.isArray(parsed.queue) || typeof parsed.queueIndex !== 'number') return null;
		return {
			queue: parsed.queue,
			queueIndex: parsed.queueIndex,
			shuffleEnabled: parsed.shuffleEnabled === true,
			shuffleIndices: Array.isArray(parsed.shuffleIndices) ? parsed.shuffleIndices : [],
			repeatMode: parsed.repeatMode === 'one' || parsed.repeatMode === 'all' ? parsed.repeatMode : 'off',
			currentTimeSeconds: typeof parsed.currentTimeSeconds === 'number' ? parsed.currentTimeSeconds : 0
		};
	} catch {
		return null;
	}
}

class PlayerStore {
	queue = $state<QueueTrack[]>([]);
	queueIndex = $state(0);
	shuffleEnabled = $state(false);
	repeatMode = $state<RepeatMode>('off');

	isPlaying = $state(false);
	isLoading = $state(false);
	currentTimeSeconds = $state(0);
	durationSeconds = $state(0);
	audioUrl = $state<string | null>(null);
	coverUrl = $state<string | null>(null);
	audioSpec = $state<AudioSpec | null>(null);
	volume = $state(readStoredVolume());
	muted = $state(false);

	private audio: HTMLAudioElement | null = null;
	private shuffleIndices: number[] = [];
	private playThresholdReached = false;
	private autoCacheTriggered = false;
	private urlExpiresAt = 0;
	private lastSessionSaveAt = 0;
	// Where to seek to once the loaded track reports a duration, consumed and
	// cleared by the 'durationchange' handler in getAudio().
	//
	// Anything that needs a position on a track that hasn't loaded yet goes
	// through here: restoring a session, re-binding after an output device
	// change, and starting past a measured silent intro. They can't collide —
	// each sets it immediately before the load whose durationchange consumes
	// it — but loadCurrent must clear it (see there) so a position set for one
	// track is never applied to the next.
	private pendingResumeSeconds: number | null = null;
	// HTMLMediaElement.play() is asynchronous — it can take real time (a
	// stream URL fetch, then the browser buffering enough to start) before
	// its promise resolves. Tracking "is a play() in flight" separately
	// from `isPlaying` closes two real bugs that showed up from treating
	// `isPlaying` as if it only ever flips once play() resolves:
	// 1) A user hitting pause while that promise is still pending saw
	//    `isPlaying` still false (not yet flipped true), so
	//    togglePlayPause's own `if (this.isPlaying)` branch took the wrong
	//    path and called play() *again* instead of pausing — the reported
	//    "pause does nothing" bug.
	// 2) Calling pause() while a play() promise is still unsettled throws
	//    in some browsers ("The play() request was interrupted..."); this
	//    flag lets pause wait for that promise first instead of racing it.
	private pendingPlay: Promise<void> | null = null;
	/** Guards against a single plug/unplug's repeated devicechange events each restarting playback. */
	private rebindingOutput = false;
	/** Where the current track's audio ends, when that has been measured and trimming is on. */
	private trimEndSeconds: number | null = null;

	constructor() {
		this.restoreSession();
		if (typeof window !== 'undefined') {
			// Catches a mid-song position that hasn't hit the next throttled
			// timeupdate save yet — visibilitychange (not beforeunload) since
			// it also fires on mobile backgrounding/tab-switch, which
			// beforeunload doesn't reliably catch at all.
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'hidden') this.saveSessionNow();
			});

			// Unplugging headphones (or any default-output change) leaves the
			// element bound to a sink that no longer exists: its clock keeps
			// running, so timeupdate still fires and the progress bar advances,
			// but nothing is audible until the media is reloaded. Re-binding it
			// to whatever is now the default restores sound without losing the
			// position, which otherwise took a full page reload.
			navigator.mediaDevices?.addEventListener('devicechange', () => {
				this.rebindOutputDevice();
			});
		}
	}

	/**
	 * Reloads the current media in place so it attaches to the current default
	 * output device, preserving position and play state.
	 *
	 * Gated on `isPlaying` — the user's intent — rather than the element's own
	 * `paused`. Losing an output device (unplugging headphones) makes the
	 * browser pause the element itself, so by the time devicechange arrives
	 * `paused` is already true; treating that as "nothing to do" is exactly
	 * why playback stayed silent until the page was reloaded.
	 */
	private async rebindOutputDevice(): Promise<void> {
		const audio = this.audio;
		if (!audio || !this.isPlaying || !audio.src || this.rebindingOutput) return;

		// A single plug/unplug typically fires devicechange more than once;
		// without this, each one would restart playback again.
		this.rebindingOutput = true;
		const resumeAt = audio.currentTime;
		try {
			await this.pendingPlay;
		} catch {
			// A play() that was already interrupted tells us nothing here.
		}
		// Seeking is deferred through the same pendingResumeSeconds path that
		// session restore uses: preload is "none" (see getAudio), so load()
		// fetches nothing on its own and there is no duration to seek against
		// until play() has started the real request.
		if (resumeAt > 0) this.pendingResumeSeconds = resumeAt;
		audio.load();
		this.pendingPlay = audio.play();
		try {
			await this.pendingPlay;
		} catch {
			// Autoplay can refuse to resume without a fresh gesture; the
			// transport controls still work, so surface nothing here.
		} finally {
			this.rebindingOutput = false;
		}
	}

	currentTrack = $derived<QueueTrack | null>(this.queue[this.queueIndex] ?? null);
	hasNext = $derived(this.queueIndex < this.queue.length - 1 || this.repeatMode !== 'off');
	hasPrevious = $derived(this.queueIndex > 0);

	private getAudio(): HTMLAudioElement {
		if (!this.audio) {
			this.audio = new Audio();
			// The default preload ("metadata" in most browsers) makes the
			// browser issue its own HEAD request against `src` as soon as
			// it's set, before play() is ever called — this account's MinIO
			// policy allows GetObject but not HeadObject (confirmed
			// directly: a HEAD against the same presigned URL a GET
			// succeeds on returns 403 regardless of how it's signed), so
			// that probe request always failed and left the element stuck
			// at readyState HAVE_NOTHING forever, with no error event ever
			// firing (browsers don't surface a failed preload HEAD as a
			// playback error) — this is what "clicking play does nothing"
			// actually was. preload="none" skips that probe entirely; the
			// real GET play() triggers is unaffected, since GetObject does
			// work.
			this.audio.preload = 'none';
			this.audio.addEventListener('timeupdate', () => {
				this.currentTimeSeconds = this.audio!.currentTime;
				this.maybeEndAtTrimPoint();
				this.maybeRecordPlay();
				this.maybeSaveSession();
			});
			this.audio.addEventListener('durationchange', () => {
				this.durationSeconds = this.audio!.duration || 0;
				if (this.pendingResumeSeconds !== null && this.durationSeconds > 0) {
					this.audio!.currentTime = Math.min(this.pendingResumeSeconds, this.durationSeconds);
					this.currentTimeSeconds = this.audio!.currentTime;
					this.pendingResumeSeconds = null;
				}
			});
			this.audio.addEventListener('ended', () => this.handleEnded());
			// Losing an output device pauses the element without the user
			// asking. devicechange alone isn't dependable here — a page that
			// has never enumerated devices may not receive it — so a pause
			// that contradicts the user's intent is treated as the same
			// signal, and playback is re-bound to whatever is now default.
			this.audio.addEventListener('pause', () => {
				if (this.isPlaying) void this.rebindOutputDevice();
			});
			this.audio.addEventListener('waiting', () => (this.isLoading = true));
			this.audio.addEventListener('canplay', () => (this.isLoading = false));
			this.audio.addEventListener('progress', () => this.maybeAutoCache());
			this.audio.volume = this.muted ? 0 : this.volume;
		}
		return this.audio;
	}

	setVolume(volume: number): void {
		this.volume = Math.min(1, Math.max(0, volume));
		this.muted = false;
		this.applyVolume();
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(VOLUME_STORAGE_KEY, String(this.volume));
		}
	}

	toggleMute(): void {
		this.muted = !this.muted;
		this.applyVolume();
	}

	private applyVolume(): void {
		const effective = this.muted ? 0 : this.volume;
		if (this.audio) this.audio.volume = effective;
	}

	/** Replaces the queue and starts playback at `startIndex`. */
	async playQueue(tracks: QueueTrack[], startIndex: number, shuffle = false): Promise<void> {
		this.queue = tracks;
		this.shuffleEnabled = shuffle;
		this.shuffleIndices = shuffle ? shuffleOrder(tracks.length) : [];
		this.queueIndex = shuffle ? this.shuffleIndices.indexOf(startIndex) : startIndex;
		await this.loadCurrent(true);
	}

	/**
	 * Appends tracks to the end of the queue without interrupting whatever's
	 * currently playing — unlike playQueue, which replaces the queue
	 * outright. If nothing is playing yet (empty queue), this starts
	 * playback at the first appended track instead of just queuing it
	 * silently, since there'd otherwise be no way to know it needs a
	 * separate play() to actually start.
	 */
	async addToQueue(tracks: QueueTrack[]): Promise<void> {
		if (tracks.length === 0) return;
		const wasEmpty = this.queue.length === 0;
		// Shuffle order only covers indices that existed when it was last
		// generated — appended tracks need their own new indices added to
		// it (at the end, same relative position as in `queue`) so they're
		// still reachable via next()/previous() while shuffled, not just
		// physically present in the array.
		const appendedIndices = tracks.map((_, i) => this.queue.length + i);
		this.queue = [...this.queue, ...tracks];
		if (this.shuffleEnabled) {
			this.shuffleIndices = [...this.shuffleIndices, ...appendedIndices];
		}
		if (wasEmpty) {
			this.queueIndex = this.shuffleEnabled ? this.shuffleIndices.indexOf(0) : 0;
			await this.loadCurrent(true);
		}
	}

	async togglePlayPause(): Promise<void> {
		if (!this.currentTrack) return;
		if (this.isPlaying) {
			await this.pause();
			return;
		}
		if (!this.audioUrl || Date.now() >= this.urlExpiresAt) {
			await this.loadCurrent(false);
			return;
		}
		await this.startPlayback();
	}

	/**
	 * `isPlaying` flips to true immediately (reflecting the user's intent
	 * the instant they hit play), not after the browser's play() promise
	 * resolves — see the `pendingPlay` field comment for why waiting until
	 * resolution made a fast pause-after-play a no-op.
	 */
	private async startPlayback(): Promise<void> {
		const audio = this.getAudio();
		this.isPlaying = true;
		const playPromise = audio.play().catch(() => {
			// A play() rejection (e.g. immediately superseded by a pause(),
			// or the source changed mid-request) isn't a real error to
			// surface — whichever call actually reflects the current
			// intent already set `isPlaying` correctly on its own.
		});
		this.pendingPlay = playPromise;
		await playPromise;
		if (this.pendingPlay === playPromise) this.pendingPlay = null;
	}

	private async pause(): Promise<void> {
		// Pausing while a play() promise is still unsettled throws in some
		// browsers ("The play() request was interrupted by a call to
		// pause()") — waiting for it first avoids that, and is safe because
		// startPlayback's own rejection handler already swallows the
		// interruption this pause() is about to cause.
		if (this.pendingPlay) await this.pendingPlay;
		// Cleared before pausing the element, not after: the 'pause' handler
		// reads this to tell a deliberate pause from the browser pausing us
		// because an output device disappeared, and would otherwise resume
		// playback the moment the user asked for it to stop.
		this.isPlaying = false;
		this.getAudio().pause();
		this.saveSessionNow();
	}

	async next(): Promise<void> {
		if (!this.advanceIndex(1)) return;
		await this.loadCurrent(true);
	}

	async previous(): Promise<void> {
		// Restart the current track if more than 3s in, like most players —
		// otherwise skip to the previous one.
		if (this.currentTimeSeconds > 3) {
			this.getAudio().currentTime = 0;
			return;
		}
		if (!this.advanceIndex(-1)) return;
		await this.loadCurrent(true);
	}

	seekTo(seconds: number): void {
		if (!this.audio) return;
		this.audio.currentTime = seconds;
		this.currentTimeSeconds = seconds;
	}

	toggleShuffle(): void {
		this.shuffleEnabled = !this.shuffleEnabled;
		const currentActualIndex = this.currentActualIndex();
		if (this.shuffleEnabled) {
			this.shuffleIndices = moveIndexToFront(shuffleOrder(this.queue.length), currentActualIndex);
			this.queueIndex = 0;
		} else {
			this.queueIndex = currentActualIndex;
			this.shuffleIndices = [];
		}
		this.saveSessionNow();
	}

	cycleRepeatMode(): void {
		this.repeatMode = cycleRepeatMode(this.repeatMode);
		this.saveSessionNow();
	}

	private currentActualIndex(): number {
		return this.shuffleEnabled ? this.shuffleIndices[this.queueIndex] : this.queueIndex;
	}

	/**
	 * The tracks still ahead in play order (not including the current
	 * one), each paired with its real index into `queue` — that index is
	 * what removeFromQueue/playFromQueue need, since play order and array
	 * order diverge once shuffle is on.
	 */
	upcoming = $derived<{ track: QueueTrack; queueArrayIndex: number }[]>(
		(this.shuffleEnabled ? this.shuffleIndices : this.queue.map((_, i) => i))
			.slice(this.queueIndex + 1)
			.map((queueArrayIndex) => ({ track: this.queue[queueArrayIndex], queueArrayIndex }))
	);

	/** Removes one track from the queue by its real array index — only ever called on an *upcoming* one, never the current or a past track. */
	removeFromQueue(queueArrayIndex: number): void {
		this.queue = this.queue.filter((_, i) => i !== queueArrayIndex);
		if (this.shuffleEnabled) {
			this.shuffleIndices = this.shuffleIndices
				.filter((i) => i !== queueArrayIndex)
				.map((i) => (i > queueArrayIndex ? i - 1 : i));
		} else if (queueArrayIndex < this.queueIndex) {
			this.queueIndex -= 1;
		}
		this.saveSessionNow();
	}

	/** Jumps playback straight to an upcoming track by its real array index. */
	async playFromQueue(queueArrayIndex: number): Promise<void> {
		this.queueIndex = this.shuffleEnabled ? this.shuffleIndices.indexOf(queueArrayIndex) : queueArrayIndex;
		await this.loadCurrent(true);
	}

	private advanceIndex(direction: 1 | -1): boolean {
		const next = nextQueueIndex(this.queueIndex, this.queue.length, direction, this.repeatMode);
		if (next === null) return false;
		this.queueIndex = next;
		return true;
	}

	private async handleEnded(): Promise<void> {
		if (this.repeatMode === 'one') {
			this.getAudio().currentTime = 0;
			await this.startPlayback();
			return;
		}
		const advanced = this.advanceIndex(1);
		if (advanced) {
			await this.loadCurrent(true);
		} else {
			this.isPlaying = false;
		}
	}

	private async loadCurrent(autoplay: boolean): Promise<void> {
		const track = this.currentTrack;
		if (!track) {
			this.isPlaying = false;
			return;
		}

		this.isLoading = true;
		this.playThresholdReached = false;
		this.autoCacheTriggered = false;
		this.currentTimeSeconds = 0;
		// Only restoreSession() should ever seek a freshly loaded track to a
		// nonzero position — without clearing this here, a stale resume
		// position left over from restoreSession() (e.g. its durationchange
		// hadn't fired yet, or this is a later track played after restore)
		// would get consumed by the *next* track's durationchange instead.
		this.pendingResumeSeconds = null;

		const response = await fetch(`/api/stream-url/${track.videoId}`);
		if (!response.ok) {
			this.isLoading = false;
			return;
		}
		const data: StreamUrlResponse = await response.json();

		this.audioUrl = data.audioUrl;
		this.coverUrl = data.coverUrl;
		this.audioSpec = { codec: data.codec, bitrateKbps: data.bitrateKbps, sampleRate: data.sampleRate };
		this.urlExpiresAt = Date.now() + data.expiresInSeconds * 1000;

		const audio = this.getAudio();
		audio.src = data.audioUrl;

		// Trim points are known before playback starts (measured after an
		// earlier play — see analyzeTrackIfCached), so the leading silence is
		// never heard: this seeks past it through the same deferred path
		// session restore uses, rather than skipping once playback is audible.
		this.trimEndSeconds = null;
		if (silenceTrim.enabled) {
			const points = getTrimPoints(track.videoId);
			if (points) {
				if (points.start > 0) this.pendingResumeSeconds = points.start;
				this.trimEndSeconds = points.end;
			}
		}

		if (autoplay) {
			await this.startPlayback();
		}
		this.isLoading = false;
		this.saveSessionNow();
	}

	/**
	 * Adopts freshly measured trim points for the track that is playing right
	 * now, so the very first play benefits too rather than waiting for the
	 * next one.
	 *
	 * The leading skip is only taken while still inside the silence — seeking
	 * once the performance has started would jump backwards or cut into it,
	 * which is worse than simply letting this play run untrimmed.
	 */
	private applyTrimPoints(videoId: string, points: { start: number; end: number }): void {
		if (this.currentTrack?.videoId !== videoId || !this.audio) return;
		this.trimEndSeconds = points.end;
		if (points.start > 0 && this.audio.currentTime < points.start) {
			this.audio.currentTime = points.start;
		}
	}

	/**
	 * Moves on at the measured end of the audio instead of sitting through the
	 * silent tail. Only ever fires past a measured point, so a track without
	 * trim points plays to its real end as before.
	 */
	private maybeEndAtTrimPoint(): void {
		if (this.trimEndSeconds === null || !this.audio || this.audio.paused) return;
		if (this.audio.currentTime < this.trimEndSeconds) return;
		// Consumed here so the handleEnded below can't re-enter through the
		// timeupdate events that fire while the next track loads.
		this.trimEndSeconds = null;
		void this.handleEnded();
	}

	private maybeRecordPlay(): void {
		if (this.playThresholdReached || !this.currentTrack) return;
		const duration = this.currentTrack.durationSeconds ?? this.durationSeconds;
		if (!hasReachedPlayThreshold(this.currentTimeSeconds, duration)) return;

		this.playThresholdReached = true;
		const videoId = this.currentTrack.videoId;
		fetch(`/api/play-event/${videoId}`, { method: 'POST' }).catch(() => {
			// Best-effort: a missed play-count increment isn't worth surfacing to the user.
		});
	}

	/**
	 * Auto-caches a song for offline playback once its audio has fully
	 * downloaded, mirroring the explicit "Download" action without
	 * requiring the user to take it — the intent is that anything played
	 * (not merely started) ends up available offline on its own, distinct
	 * from downloadSongForOffline which stays a separate, explicit path
	 * for songs the user wants cached ahead of ever playing them.
	 * `progress` fires repeatedly as more of the file arrives; this only
	 * acts once per track, on the event whose buffered range first covers
	 * the whole duration.
	 */
	private maybeAutoCache(): void {
		if (this.autoCacheTriggered || !this.audio || !this.currentTrack || !this.audioUrl) return;
		const duration = this.audio.duration;
		if (!Number.isFinite(duration) || duration <= 0) return;

		const buffered = this.audio.buffered;
		const fullyBuffered =
			buffered.length > 0 && buffered.end(buffered.length - 1) >= duration - 0.5;
		if (!fullyBuffered) return;

		this.autoCacheTriggered = true;
		const videoId = this.currentTrack.videoId;
		precacheAudio(videoId, this.audioUrl)
			.then(async (cached) => {
				// Measured from the cached copy so the analysis reads from disk
				// rather than pulling the audio down a second time. This runs as
				// soon as the track is fully buffered — long before it finishes —
				// so the result can still be applied to the play in progress.
				if (!cached || !silenceTrim.enabled) return;
				const points = await analyzeTrackIfCached(videoId);
				if (points) this.applyTrimPoints(videoId, points);
			})
			.catch(() => {
				// Best-effort: same as maybeRecordPlay above, a missed cache write isn't worth surfacing.
			});
	}

	private maybeSaveSession(): void {
		const now = Date.now();
		if (now - this.lastSessionSaveAt < SESSION_SAVE_INTERVAL_MS) return;
		this.lastSessionSaveAt = now;
		this.saveSessionNow();
	}

	/**
	 * Persists everything needed to resume where the user left off after a
	 * reload: the queue itself, shuffle/repeat state, and last known
	 * position. Called on a throttled timer during playback (see
	 * maybeSaveSession) and immediately after anything that isn't covered
	 * by that timer — queue edits, pause, track changes — so those aren't
	 * silently lost if the tab closes before the next tick.
	 */
	private saveSessionNow(): void {
		if (typeof localStorage === 'undefined') return;
		if (this.queue.length === 0) {
			localStorage.removeItem(SESSION_STORAGE_KEY);
			return;
		}
		const session: PersistedSession = {
			queue: this.queue,
			queueIndex: this.queueIndex,
			shuffleEnabled: this.shuffleEnabled,
			shuffleIndices: this.shuffleIndices,
			repeatMode: this.repeatMode,
			currentTimeSeconds: this.currentTimeSeconds
		};
		localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
	}

	/**
	 * Restores the last session on construction — loads the track paused
	 * (never autoplay: browsers block unprompted audio anyway, and
	 * resuming sound on its own the moment a page loads would be
	 * surprising even where it's not blocked) and queues up a seek to the
	 * saved position for once its duration becomes known.
	 */
	private restoreSession(): void {
		const session = readStoredSession();
		if (!session || session.queue.length === 0) return;
		if (session.queueIndex < 0 || session.queueIndex >= session.queue.length) return;

		this.queue = session.queue;
		this.queueIndex = session.queueIndex;
		this.shuffleEnabled = session.shuffleEnabled;
		this.shuffleIndices = session.shuffleIndices;
		this.repeatMode = session.repeatMode;
		this.pendingResumeSeconds = session.currentTimeSeconds;
		this.currentTimeSeconds = session.currentTimeSeconds;

		this.loadCurrent(false).catch(() => {
			// Best-effort: a failed restore just leaves the player empty,
			// same as a first visit.
		});
	}
}

export const player = new PlayerStore();
