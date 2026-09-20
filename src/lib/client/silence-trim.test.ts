import { describe, it, expect, beforeEach } from 'vitest';
import { SilenceDetector } from './silence-trim.svelte';

/**
 * Drives a detector without a real AudioContext: `attach` builds the Web
 * Audio graph, which jsdom has no implementation of, so the private fields it
 * would populate are stubbed instead. `level` is the peak amplitude the
 * analyser reports, and `state` lets a test hold the context "suspended" the
 * way a browser does before playback is allowed.
 */
function detectorReading(level: number, state: AudioContextState = 'running'): SilenceDetector {
	const detector = new SilenceDetector();
	const internals = detector as unknown as {
		analyser: { getFloatTimeDomainData(buffer: Float32Array): void };
		buffer: Float32Array;
		context: { state: AudioContextState };
	};
	internals.buffer = new Float32Array(8);
	internals.analyser = {
		getFloatTimeDomainData(buffer: Float32Array) {
			buffer.fill(level);
		}
	};
	internals.context = { state };
	return detector;
}

const SILENT = 0;
const AUDIBLE = 0.4;
/** Quiet, but clearly signal rather than digital silence — a soft intro. */
const QUIET_INTRO = 0.02;
/** A very soft fade-in: still orders of magnitude above the silence floor. */
const FAINT_FADE_IN = 0.002;

describe('leading silence', () => {
	it('does not report silence before the context is running', () => {
		// A suspended context reports all-zero samples, which is
		// indistinguishable from real silence — assuming silence here is what
		// made tracks skip their own openings.
		const detector = detectorReading(SILENT, 'suspended');
		expect(detector.isLeadingSilence(0)).toBe(false);
		expect(detector.isLeadingSilence(0.2)).toBe(false);
	});

	it('reports silence only once it has persisted across several reads', () => {
		const detector = detectorReading(SILENT);
		expect(detector.isLeadingSilence(0)).toBe(false);
		expect(detector.isLeadingSilence(0.2)).toBe(false);
		expect(detector.isLeadingSilence(0.4)).toBe(false);
		expect(detector.isLeadingSilence(0.6)).toBe(true);
	});

	it('never skips a track that opens with sound', () => {
		// The reported bug: songs with no leading silence were being skipped
		// into anyway.
		const detector = detectorReading(AUDIBLE);
		for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
			expect(detector.isLeadingSilence(t)).toBe(false);
		}
	});

	it('leaves even a very faint fade-in alone', () => {
		const detector = detectorReading(FAINT_FADE_IN);
		for (const t of [0, 0.2, 0.4, 0.6, 0.8]) {
			expect(detector.isLeadingSilence(t)).toBe(false);
		}
	});

	it('leaves a quiet intro alone', () => {
		const detector = detectorReading(QUIET_INTRO);
		for (const t of [0, 0.2, 0.4, 0.6]) {
			expect(detector.isLeadingSilence(t)).toBe(false);
		}
		expect(detector.leadSkipDone).toBe(true);
	});

	it('stops skipping as soon as audible content arrives', () => {
		const detector = detectorReading(AUDIBLE);
		expect(detector.isLeadingSilence(0)).toBe(false);
		expect(detector.leadSkipDone).toBe(true);
	});

	it('gives up past the cap so the music itself is never skipped', () => {
		const detector = detectorReading(SILENT);
		expect(detector.isLeadingSilence(30)).toBe(false);
		expect(detector.leadSkipDone).toBe(true);
	});
});

describe('trailing silence', () => {
	it('ignores silence outside the tail, however long it lasts', () => {
		// Trimming only ever removes padding at the two edges of a file — a
		// silent break in the middle of a track must never end it early.
		const detector = detectorReading(SILENT);
		for (const t of [10, 30, 50, 70, 80]) {
			expect(detector.isTrailingSilence(t, 100)).toBe(false);
		}
	});

	it('does not end a track on an untrustworthy reading', () => {
		const detector = detectorReading(SILENT, 'suspended');
		expect(detector.isTrailingSilence(90, 100)).toBe(false);
		expect(detector.isTrailingSilence(95, 100)).toBe(false);
	});

	it('only starts watching once the tail is reached', () => {
		const detector = detectorReading(SILENT);
		// Just outside the window: still part of the song.
		expect(detector.isTrailingSilence(84, 100)).toBe(false);
		// Inside it, silence begins accumulating.
		expect(detector.isTrailingSilence(86, 100)).toBe(false);
		expect(detector.isTrailingSilence(88, 100)).toBe(true);
	});

	it('ends the track once silence has lasted long enough', () => {
		const detector = detectorReading(SILENT);
		expect(detector.isTrailingSilence(90, 100)).toBe(false);
		expect(detector.isTrailingSilence(91, 100)).toBe(false);
		expect(detector.isTrailingSilence(92, 100)).toBe(true);
	});

	it('treats a brief dip between notes as part of the track', () => {
		const quiet = detectorReading(SILENT);
		expect(quiet.isTrailingSilence(90, 100)).toBe(false);

		const loud = detectorReading(AUDIBLE);
		expect(loud.isTrailingSilence(91, 100)).toBe(false);
		// Audible again, so the silence timer restarts rather than accumulating.
		expect(loud.isTrailingSilence(95, 100)).toBe(false);
	});
});

describe('reset', () => {
	let detector: SilenceDetector;
	beforeEach(() => {
		detector = detectorReading(SILENT);
	});

	it('clears lead-skip state so the next track is judged on its own', () => {
		detector.isLeadingSilence(0);
		detector.isLeadingSilence(0.2);
		detector.isLeadingSilence(0.4);
		detector.reset();
		expect(detector.leadSkipDone).toBe(false);
		// The read counter restarts too, so silence must persist again.
		expect(detector.isLeadingSilence(0)).toBe(false);
	});
});
