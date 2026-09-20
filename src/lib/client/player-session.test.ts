import { describe, it, expect } from 'vitest';
import { parseStoredSession, parseStoredVolume, type PersistedSession } from './player-session';

const valid: PersistedSession = {
	queue: [{ videoId: 'a', title: 'A', durationSeconds: 100 }],
	queueIndex: 0,
	shuffleEnabled: false,
	shuffleIndices: [],
	repeatMode: 'off',
	currentTimeSeconds: 12
};

describe('parseStoredVolume', () => {
	it('defaults to full when nothing is stored', () => {
		expect(parseStoredVolume(null)).toBe(1);
	});

	it('reads back a stored fraction', () => {
		expect(parseStoredVolume('0.35')).toBeCloseTo(0.35);
	});

	it('clamps a value outside the range rather than trusting it', () => {
		// Storage is user-writable; an out-of-range number would either mute
		// the player for good or be rejected by the media element.
		expect(parseStoredVolume('-1')).toBe(0);
		expect(parseStoredVolume('5')).toBe(1);
	});

	it('falls back to full for anything unparseable', () => {
		expect(parseStoredVolume('not a number')).toBe(1);
		expect(parseStoredVolume('')).toBe(1);
	});
});

describe('parseStoredSession', () => {
	it('round-trips a session', () => {
		expect(parseStoredSession(JSON.stringify(valid))).toEqual(valid);
	});

	it('returns null when nothing is stored', () => {
		expect(parseStoredSession(null)).toBeNull();
	});

	it('returns null for a truncated or hand-edited write', () => {
		expect(parseStoredSession('{"queue":[')).toBeNull();
		expect(parseStoredSession('not json at all')).toBeNull();
	});

	it('rejects a session with no queue', () => {
		expect(parseStoredSession(JSON.stringify({ queueIndex: 0 }))).toBeNull();
	});

	it('rejects an index outside the queue rather than restoring half of it', () => {
		// currentTrack would be undefined, leaving the player loaded but with
		// nothing to play and no way to tell why.
		expect(parseStoredSession(JSON.stringify({ ...valid, queueIndex: 5 }))).toBeNull();
		expect(parseStoredSession(JSON.stringify({ ...valid, queueIndex: -1 }))).toBeNull();
	});

	it('falls back to sane values for fields an older deploy did not write', () => {
		const partial = JSON.stringify({ queue: valid.queue, queueIndex: 0 });
		expect(parseStoredSession(partial)).toEqual({
			queue: valid.queue,
			queueIndex: 0,
			shuffleEnabled: false,
			shuffleIndices: [],
			repeatMode: 'off',
			currentTimeSeconds: 0
		});
	});

	it('only accepts the repeat modes that exist', () => {
		const bogus = JSON.stringify({ ...valid, repeatMode: 'sideways' });
		expect(parseStoredSession(bogus)?.repeatMode).toBe('off');
		expect(parseStoredSession(JSON.stringify({ ...valid, repeatMode: 'all' }))?.repeatMode).toBe(
			'all'
		);
	});

	it('refuses a negative or non-finite position', () => {
		expect(
			parseStoredSession(JSON.stringify({ ...valid, currentTimeSeconds: -5 }))?.currentTimeSeconds
		).toBe(0);
		expect(
			parseStoredSession(JSON.stringify({ ...valid, currentTimeSeconds: 'soon' }))
				?.currentTimeSeconds
		).toBe(0);
	});
});
