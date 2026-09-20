import { describe, it, expect } from 'vitest';
import { findTrimPoints } from './silence-trim.svelte';

const SAMPLE_RATE = 8000;

/**
 * Builds a track from [seconds, amplitude] spans. Amplitude is a peak value in
 * 0-1, and the tone is arbitrary — only its level matters to the measurement.
 */
function track(...spans: [number, number][]): Float32Array {
	const total = spans.reduce((n, [seconds]) => n + Math.round(seconds * SAMPLE_RATE), 0);
	const samples = new Float32Array(total);
	let at = 0;
	for (const [seconds, amplitude] of spans) {
		const count = Math.round(seconds * SAMPLE_RATE);
		for (let i = 0; i < count; i++) {
			samples[at + i] = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * amplitude;
		}
		at += count;
	}
	return samples;
}

describe('findTrimPoints', () => {
	it('finds the edges of a track padded with digital silence', () => {
		// A second of margin is kept either side of the measured edges, so the
		// trim lands just outside the audio rather than exactly on it.
		const samples = track([2, 0], [10, 0.5], [3, 0]);
		const { start, end } = findTrimPoints(samples, SAMPLE_RATE);
		expect(start).toBeCloseTo(1, 1);
		expect(end).toBeCloseTo(13, 1);
	});

	it('never backs the margin out past the track itself', () => {
		const samples = track([0.2, 0], [3, 0.5], [0.2, 0]);
		const { start, end } = findTrimPoints(samples, SAMPLE_RATE);
		expect(start).toBe(0);
		expect(end).toBeCloseTo(3.4, 1);
	});

	it('treats a noise floor well below the content as silence', () => {
		// The case this was designed against: a live recording whose opening
		// is audible only as clothing rustle, far under the performance.
		const samples = track([3, 0], [17, 0.0005], [60, 0.25], [18, 0]);
		const { start, end } = findTrimPoints(samples, SAMPLE_RATE);
		expect(start).toBeCloseTo(19, 0);
		expect(end).toBeCloseTo(81, 0);
	});

	it('keeps a quiet intro that is still part of the performance', () => {
		// A real fade-in sits within 40 dB of the track's own loudness, unlike
		// a noise floor, so it must not be trimmed.
		const samples = track([4, 0.05], [10, 0.5]);
		const { start } = findTrimPoints(samples, SAMPLE_RATE);
		expect(start).toBeCloseTo(0, 1);
	});

	it('leaves a track with no padding untouched', () => {
		const samples = track([10, 0.4]);
		const { start, end } = findTrimPoints(samples, SAMPLE_RATE);
		expect(start).toBeCloseTo(0, 1);
		expect(end).toBeCloseTo(10, 1);
	});

	it('ignores silence in the middle of a track', () => {
		const samples = track([5, 0.4], [4, 0], [5, 0.4]);
		const { start, end } = findTrimPoints(samples, SAMPLE_RATE);
		expect(start).toBeCloseTo(0, 1);
		expect(end).toBeCloseTo(14, 1);
	});

	it('returns the whole track when it is silent throughout', () => {
		const samples = track([5, 0]);
		const { start, end } = findTrimPoints(samples, SAMPLE_RATE);
		expect(start).toBe(0);
		expect(end).toBeCloseTo(5, 1);
	});

	it('handles audio shorter than one analysis window', () => {
		const { start, end } = findTrimPoints(new Float32Array(10), SAMPLE_RATE);
		expect(start).toBe(0);
		expect(end).toBeGreaterThanOrEqual(0);
	});
});
