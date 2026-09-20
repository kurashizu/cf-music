import { describe, it, expect } from 'vitest';
import { formatDuration, formatLongDuration, formatAudioSpec, formatBytes } from './format';

describe('formatDuration', () => {
	it('pads seconds so times stay aligned in a list', () => {
		expect(formatDuration(65)).toBe('1:05');
		expect(formatDuration(600)).toBe('10:00');
	});

	it('marks an unknown duration rather than showing 0:00', () => {
		expect(formatDuration(null)).toBe('—');
	});

	it('does not round a partial second up into the next one', () => {
		expect(formatDuration(59.9)).toBe('0:59');
	});
});

describe('formatLongDuration', () => {
	it('omits the hour when there isn’t one', () => {
		expect(formatLongDuration(125)).toBe('2:05');
	});

	it('pads minutes once hours are shown', () => {
		expect(formatLongDuration(3725)).toBe('1:02:05');
	});
});

describe('formatAudioSpec', () => {
	it('includes the bitrate when it is known', () => {
		expect(formatAudioSpec('opus', 141)).toBe('opus · 141kbps');
	});

	it('falls back to the codec alone', () => {
		expect(formatAudioSpec('opus', null)).toBe('opus');
	});

	it('renders nothing without a codec', () => {
		expect(formatAudioSpec(null, 141)).toBe('');
	});
});

describe('formatBytes', () => {
	it('leaves small values in bytes', () => {
		expect(formatBytes(512)).toBe('512 B');
	});

	it('steps up through units', () => {
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
	});

	it('stops at gigabytes rather than inventing a larger unit', () => {
		expect(formatBytes(3 * 1024 ** 4)).toBe('3072.0 GB');
	});
});
