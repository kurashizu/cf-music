import { describe, it, expect } from 'vitest';
import {
	formatDuration,
	formatLongDuration,
	formatAudioSpec,
	formatBytes,
	formatPlaybackTime,
	formatCompactDuration,
	formatDateTime
} from './format';

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

describe('formatPlaybackTime', () => {
	it('formats a position as m:ss', () => {
		expect(formatPlaybackTime(0)).toBe('0:00');
		expect(formatPlaybackTime(65)).toBe('1:05');
		expect(formatPlaybackTime(3599)).toBe('59:59');
	});

	it('reads as zero for a duration the media element has not resolved yet', () => {
		// <audio>.duration is NaN until metadata loads; an em dash mid-playback
		// would be wrong, which is why this differs from formatDuration.
		expect(formatPlaybackTime(NaN)).toBe('0:00');
		expect(formatPlaybackTime(Infinity)).toBe('0:00');
		expect(formatPlaybackTime(-1)).toBe('0:00');
	});
});

describe('formatCompactDuration', () => {
	it('drops the hour when there is none', () => {
		expect(formatCompactDuration(0)).toBe('0m');
		expect(formatCompactDuration(59)).toBe('0m');
		expect(formatCompactDuration(600)).toBe('10m');
	});

	it('reads as hours and minutes once past an hour', () => {
		expect(formatCompactDuration(3600)).toBe('1h 0m');
		expect(formatCompactDuration(8100)).toBe('2h 15m');
	});
});

describe('formatBytes at the scales a quota is set in', () => {
	it('scales rather than forcing one unit', () => {
		// The admin page used to divide by 1024^3 unconditionally, so a 200MB
		// quota read as "0.20 GB" while every other page said "200.0 MB".
		expect(formatBytes(200 * 1024 * 1024)).toBe('200.0 MB');
		expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB');
	});
});
