const STORAGE_KEY = 'krsz-music:trim-silence';

function readStored(): boolean {
	if (typeof localStorage === 'undefined') return false;
	return localStorage.getItem(STORAGE_KEY) === 'on';
}

/**
 * Whether playback should skip the silence at the start and end of a track.
 *
 * Off by default, and a browser-local preference like view mode and volume:
 * it changes how this device plays, not anything about the library. The
 * stored audio is never modified — the original file stays the source of
 * truth, so the setting can be turned off again at any time with nothing to
 * undo.
 */
class SilenceTrimStore {
	enabled = $state<boolean>(readStored());

	/**
	 * Notified when the setting changes, so the player can rebuild its audio
	 * element: `crossOrigin` has to be set before `src` is assigned and the
	 * element is created once per session, so a live toggle can't otherwise
	 * take effect until the next reload.
	 */
	onChange: (() => void) | null = null;

	set(enabled: boolean): void {
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
		}
		this.onChange?.();
	}

	toggle(): void {
		this.set(!this.enabled);
	}
}

export const silenceTrim = new SilenceTrimStore();

/** Below this peak amplitude (0-1) a moment counts as silence. */
const SILENCE_PEAK = 0.015;
/** Ignore a dip shorter than this; music has plenty of brief near-silent moments. */
const TRAILING_SILENCE_SECONDS = 1.5;
/** Give up looking for the intro to start after this, so a quiet fade-in is never skipped wholesale. */
const MAX_LEAD_SKIP_SECONDS = 20;

/**
 * Watches an element's actual output level to find where a track's audible
 * content begins and ends.
 *
 * Measuring playback beats analysing the file: decoding a whole track up
 * front would mean fetching it in full before playing anything, and the
 * element streams from a presigned URL it manages itself. The cost here is
 * one analyser node reading a small buffer a few times a second.
 *
 * Chromium and WebKit both refuse to build a MediaElementSource for an
 * element whose media is cross-origin without CORS, which is exactly what a
 * presigned URL is — hence `crossOrigin`; if the source still can't be
 * created, this reports no trim points rather than breaking playback.
 */
export class SilenceDetector {
	private context: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private source: MediaElementAudioSourceNode | null = null;
	private buffer: Float32Array<ArrayBuffer> | null = null;
	private quietSince: number | null = null;

	/** Set once audible content has been found, so the intro is only skipped once per track. */
	leadSkipDone = false;

	/**
	 * Attaches to `audio`. A media element can only ever have one
	 * MediaElementAudioSource, so this is created once and reused for every
	 * track the element plays.
	 */
	attach(audio: HTMLAudioElement): boolean {
		if (this.source) return true;
		const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!Ctor) return false;
		try {
			this.context = new Ctor();
			this.source = this.context.createMediaElementSource(audio);
			this.analyser = this.context.createAnalyser();
			this.analyser.fftSize = 2048;
			this.buffer = new Float32Array(this.analyser.fftSize);
			// Still routed to the speakers: an analyser is a pass-through, but
			// creating the source alone diverts the element's output into the
			// graph, so without this the track would play silently.
			this.source.connect(this.analyser);
			this.analyser.connect(this.context.destination);
			return true;
		} catch {
			this.context = null;
			this.analyser = null;
			this.source = null;
			return false;
		}
	}

	/** Browsers start an AudioContext suspended until a gesture; call this alongside play(). */
	resume(): void {
		if (this.context?.state === 'suspended') void this.context.resume();
	}

	reset(): void {
		this.leadSkipDone = false;
		this.quietSince = null;
	}

	/**
	 * Drops the graph entirely. A MediaElementAudioSource stays bound to the
	 * element it was built from, so it can't be carried over to a replacement.
	 */
	detach(): void {
		this.reset();
		void this.context?.close();
		this.context = null;
		this.analyser = null;
		this.source = null;
		this.buffer = null;
	}

	private peak(): number {
		if (!this.analyser || !this.buffer) return 1;
		this.analyser.getFloatTimeDomainData(this.buffer);
		let peak = 0;
		for (const sample of this.buffer) {
			const magnitude = Math.abs(sample);
			if (magnitude > peak) peak = magnitude;
		}
		return peak;
	}

	/** True once the track is audibly over, even though the file still has time left. */
	isTrailingSilence(currentTime: number, duration: number): boolean {
		if (duration <= 0 || currentTime < duration / 2) return false;
		if (this.peak() >= SILENCE_PEAK) {
			this.quietSince = null;
			return false;
		}
		if (this.quietSince === null) {
			this.quietSince = currentTime;
			return false;
		}
		return currentTime - this.quietSince >= TRAILING_SILENCE_SECONDS;
	}

	/** True while the intro is still silent and worth skipping past. */
	isLeadingSilence(currentTime: number): boolean {
		if (this.leadSkipDone || currentTime > MAX_LEAD_SKIP_SECONDS) {
			this.leadSkipDone = true;
			return false;
		}
		if (this.peak() >= SILENCE_PEAK) {
			this.leadSkipDone = true;
			return false;
		}
		return true;
	}
}
