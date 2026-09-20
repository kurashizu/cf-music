import { audioCacheKey } from '$lib/shared/audio-cache-key';

const STORAGE_KEY = 'krsz-music:trim-silence';
const TRIM_POINTS_KEY = 'krsz-music:trim-points';

function readStored(): boolean {
	if (typeof localStorage === 'undefined') return false;
	return localStorage.getItem(STORAGE_KEY) === 'on';
}

/**
 * Whether playback should start past a track's leading silence and move on at
 * its trailing silence.
 *
 * A browser-local preference like view mode and volume: it changes how this
 * device plays, not anything about the library. The stored audio is never
 * modified — trim points are measured from it and kept alongside, so turning
 * the setting off leaves nothing to undo.
 */
class SilenceTrimStore {
	enabled = $state<boolean>(readStored());

	set(enabled: boolean): void {
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
		}
	}

	toggle(): void {
		this.set(!this.enabled);
	}
}

export const silenceTrim = new SilenceTrimStore();

/** Where a track's audible content starts and ends, in seconds. */
export interface TrimPoints {
	start: number;
	end: number;
}

/**
 * Analysis window. 50ms is short enough to place an edge precisely and long
 * enough that one transient can't swing the measurement.
 */
const WINDOW_SECONDS = 0.05;

/**
 * How far below a track's own typical loudness still counts as silence.
 *
 * Measured against the track rather than as an absolute level, because the
 * gap that matters is between a recording's noise floor and its content, and
 * that sits at a different absolute level in every file. Verified against a
 * live recording whose first 20s are audible only as clothing rustle around
 * -65 dB under content at -12 dB: -30 and -40 both place the start correctly,
 * while -50 mistakes the rustle for the performance, so -40 sits in the
 * middle of the working range rather than at its edge.
 */
const SILENCE_BELOW_DB = -40;

/**
 * Decode target. Level detection needs amplitude over time, not fidelity, and
 * mono 8kHz costs about a sixth of the memory of the source — which matters
 * on a phone, where a five-minute track decodes to ~115MB at full quality.
 */
const ANALYSIS_SAMPLE_RATE = 8000;

/** Skip anything longer than this rather than decode it; the memory isn't worth one trim. */
const MAX_ANALYSIS_SECONDS = 15 * 60;

/** Kept on either side of the measured edges, so a trim never clips an onset or a decay. */
const EDGE_MARGIN_SECONDS = 1;

function readTrimPoints(): Record<string, TrimPoints> {
	if (typeof localStorage === 'undefined') return {};
	try {
		return JSON.parse(localStorage.getItem(TRIM_POINTS_KEY) ?? '{}') as Record<string, TrimPoints>;
	} catch {
		return {};
	}
}

export function getTrimPoints(videoId: string): TrimPoints | null {
	return readTrimPoints()[videoId] ?? null;
}

function saveTrimPoints(videoId: string, points: TrimPoints): void {
	if (typeof localStorage === 'undefined') return;
	const all = readTrimPoints();
	all[videoId] = points;
	localStorage.setItem(TRIM_POINTS_KEY, JSON.stringify(all));
}

/** Drops every measurement — used when local data is cleared. */
export function clearTrimPoints(): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.removeItem(TRIM_POINTS_KEY);
}

/**
 * Finds where audible content starts and ends in decoded audio.
 *
 * Exported for tests: the surrounding fetch/decode needs a browser, but the
 * measurement itself is plain arithmetic over samples.
 */
export function findTrimPoints(samples: Float32Array, sampleRate: number): TrimPoints {
	const windowSize = Math.max(1, Math.floor(sampleRate * WINDOW_SECONDS));
	const windowCount = Math.floor(samples.length / windowSize);
	if (windowCount === 0) return { start: 0, end: samples.length / sampleRate };

	const rms = new Float32Array(windowCount);
	for (let w = 0; w < windowCount; w++) {
		let sum = 0;
		const from = w * windowSize;
		for (let i = from; i < from + windowSize; i++) sum += samples[i] * samples[i];
		rms[w] = Math.sqrt(sum / windowSize);
	}

	// The 90th percentile stands in for "how loud this track normally is".
	// A mean would be dragged down by the very silence being looked for, and
	// the peak would be set by a single transient.
	const ranked = Array.from(rms)
		.filter((v) => v > 0)
		.sort((a, b) => a - b);
	if (ranked.length === 0) return { start: 0, end: windowCount * windowSize / sampleRate };
	const loudness = ranked[Math.floor(ranked.length * 0.9)];
	const threshold = loudness * Math.pow(10, SILENCE_BELOW_DB / 20);

	let first = 0;
	while (first < windowCount && rms[first] < threshold) first++;
	let last = windowCount - 1;
	while (last > first && rms[last] < threshold) last--;

	// Nothing cleared the threshold: treat the track as entirely audible
	// rather than trimming all of it away.
	if (first >= windowCount) return { start: 0, end: (windowCount * windowSize) / sampleRate };

	// Back off a moment from each edge. The measurement lands on the first
	// window that clears the threshold, which is already slightly inside the
	// attack, and a soft onset can sit just under it — starting a beat early
	// keeps that audible rather than clipping into the first note.
	const measuredStart = (first * windowSize) / sampleRate;
	const measuredEnd = ((last + 1) * windowSize) / sampleRate;
	const trackEnd = (windowCount * windowSize) / sampleRate;
	return {
		start: Math.max(0, measuredStart - EDGE_MARGIN_SECONDS),
		end: Math.min(trackEnd, measuredEnd + EDGE_MARGIN_SECONDS)
	};
}

let analysisInFlight: string | null = null;

/**
 * Measures and stores a track's trim points, reading the audio the service
 * worker already cached after it finished playing (see precacheAudio) so this
 * costs no network.
 *
 * Deliberately does nothing when the track isn't cached yet: the first play
 * is what populates that cache, so trimming simply starts applying from the
 * second play onward rather than making the first one wait.
 */
export async function analyzeTrackIfCached(videoId: string): Promise<TrimPoints | null> {
	if (typeof caches === 'undefined' || analysisInFlight === videoId) return null;
	if (getTrimPoints(videoId)) return getTrimPoints(videoId);

	analysisInFlight = videoId;
	try {
		const cache = await caches.open('audio-v1');
		const hit = await cache.match(audioCacheKey(videoId));
		if (!hit) return null;

		const encoded = await hit.arrayBuffer();
		const context = new OfflineAudioContext(1, ANALYSIS_SAMPLE_RATE, ANALYSIS_SAMPLE_RATE);
		const decoded = await context.decodeAudioData(encoded);
		if (decoded.duration > MAX_ANALYSIS_SECONDS) return null;

		const points = findTrimPoints(decoded.getChannelData(0), decoded.sampleRate);
		saveTrimPoints(videoId, points);
		return points;
	} catch {
		// A track that can't be decoded just doesn't get trimmed.
		return null;
	} finally {
		analysisInFlight = null;
	}
}
