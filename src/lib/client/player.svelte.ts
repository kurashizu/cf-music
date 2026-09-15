import { hasReachedPlayThreshold } from '$lib/shared/playback';
import { shuffleOrder, nextQueueIndex, cycleRepeatMode, moveIndexToFront, type RepeatMode } from '$lib/shared/queue';

export interface QueueTrack {
	videoId: string;
	title: string;
	durationSeconds: number | null;
}

interface StreamUrlResponse {
	audioUrl: string;
	coverUrl: string | null;
	expiresInSeconds: number;
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

	private audio: HTMLAudioElement | null = null;
	private shuffleIndices: number[] = [];
	private playThresholdReached = false;
	private urlExpiresAt = 0;
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
				this.maybeRecordPlay();
			});
			this.audio.addEventListener('durationchange', () => {
				this.durationSeconds = this.audio!.duration || 0;
			});
			this.audio.addEventListener('ended', () => this.handleEnded());
			this.audio.addEventListener('waiting', () => (this.isLoading = true));
			this.audio.addEventListener('canplay', () => (this.isLoading = false));
		}
		return this.audio;
	}

	/** Replaces the queue and starts playback at `startIndex`. */
	async playQueue(tracks: QueueTrack[], startIndex: number, shuffle = false): Promise<void> {
		this.queue = tracks;
		this.shuffleEnabled = shuffle;
		this.shuffleIndices = shuffle ? shuffleOrder(tracks.length) : [];
		this.queueIndex = shuffle ? this.shuffleIndices.indexOf(startIndex) : startIndex;
		await this.loadCurrent(true);
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
		this.getAudio().pause();
		this.isPlaying = false;
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
	}

	cycleRepeatMode(): void {
		this.repeatMode = cycleRepeatMode(this.repeatMode);
	}

	private currentActualIndex(): number {
		return this.shuffleEnabled ? this.shuffleIndices[this.queueIndex] : this.queueIndex;
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
		this.currentTimeSeconds = 0;

		const response = await fetch(`/api/stream-url/${track.videoId}`);
		if (!response.ok) {
			this.isLoading = false;
			return;
		}
		const data: StreamUrlResponse = await response.json();

		this.audioUrl = data.audioUrl;
		this.coverUrl = data.coverUrl;
		this.urlExpiresAt = Date.now() + data.expiresInSeconds * 1000;

		const audio = this.getAudio();
		audio.src = data.audioUrl;

		if (autoplay) {
			await this.startPlayback();
		}
		this.isLoading = false;
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
}

export const player = new PlayerStore();
