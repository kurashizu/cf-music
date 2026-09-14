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

	currentTrack = $derived<QueueTrack | null>(this.queue[this.queueIndex] ?? null);
	hasNext = $derived(this.queueIndex < this.queue.length - 1 || this.repeatMode !== 'off');
	hasPrevious = $derived(this.queueIndex > 0);

	private getAudio(): HTMLAudioElement {
		if (!this.audio) {
			this.audio = new Audio();
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
		const audio = this.getAudio();
		if (this.isPlaying) {
			audio.pause();
			this.isPlaying = false;
			return;
		}
		if (!this.audioUrl || Date.now() >= this.urlExpiresAt) {
			await this.loadCurrent(false);
		}
		await audio.play();
		this.isPlaying = true;
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
			await this.getAudio().play();
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
			await audio.play();
			this.isPlaying = true;
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
