import { describe, it, expect } from 'vitest';
import { isAtEndOfMedia, END_OF_MEDIA_TOLERANCE_SECONDS } from './audio-end-detection';

/**
 * These guard a real regression: a media element fires `pause` just before
 * `ended`, and treating that pause as a lost output device made the player
 * reload the finished track and freeze at its own duration.
 */
describe('isAtEndOfMedia', () => {
	it('trusts the ended flag', () => {
		expect(isAtEndOfMedia({ ended: true, currentTime: 0, duration: 184 })).toBe(true);
	});

	it('is true at the duration, before ended has fired', () => {
		expect(isAtEndOfMedia({ ended: false, currentTime: 184, duration: 184 })).toBe(true);
	});

	it('is true a few milliseconds short, where currentTime usually stops', () => {
		expect(
			isAtEndOfMedia({
				ended: false,
				currentTime: 184 - END_OF_MEDIA_TOLERANCE_SECONDS / 2,
				duration: 184
			})
		).toBe(true);
	});

	it('is false for a pause in the middle of a track', () => {
		// This is the headphone-unplug case the player must still recover from.
		expect(isAtEndOfMedia({ ended: false, currentTime: 92, duration: 184 })).toBe(false);
	});

	it('is false just outside the tolerance', () => {
		expect(
			isAtEndOfMedia({
				ended: false,
				currentTime: 184 - END_OF_MEDIA_TOLERANCE_SECONDS * 2,
				duration: 184
			})
		).toBe(false);
	});

	it('is false before metadata gives a duration', () => {
		// duration is NaN until metadata loads; a pause then is not an ending.
		expect(isAtEndOfMedia({ ended: false, currentTime: 0, duration: NaN })).toBe(false);
		expect(isAtEndOfMedia({ ended: false, currentTime: 0, duration: 0 })).toBe(false);
	});

	it('is false for a live stream with no fixed duration', () => {
		expect(isAtEndOfMedia({ ended: false, currentTime: 9999, duration: Infinity })).toBe(false);
	});
});
