import { describe, it, expect } from 'vitest';
import {
	audioCacheKey,
	extractVideoIdFromAudioPath,
	coverCacheKey,
	extractVideoIdFromCoverPath
} from './audio-cache-key';

describe('audioCacheKey', () => {
	it('produces a stable key scoped to the videoId', () => {
		expect(audioCacheKey('abc123')).toBe('https://audio.cf-music.internal/abc123');
	});

	it('produces different keys for different videoIds', () => {
		expect(audioCacheKey('a')).not.toBe(audioCacheKey('b'));
	});
});

describe('extractVideoIdFromAudioPath', () => {
	it('extracts the videoId from a bucket-prefixed audio path', () => {
		expect(extractVideoIdFromAudioPath('/cf-music/audio/dQw4w9WgXcQ.webm')).toBe('dQw4w9WgXcQ');
	});

	it('extracts the videoId regardless of the audio file extension', () => {
		expect(extractVideoIdFromAudioPath('/cf-music/audio/abc123.m4a')).toBe('abc123');
	});

	it('returns null for a cover image path (not under audio/)', () => {
		expect(extractVideoIdFromAudioPath('/cf-music/covers/abc123.avif')).toBeNull();
	});

	it('returns null for a path with no file extension', () => {
		expect(extractVideoIdFromAudioPath('/cf-music/audio/abc123')).toBeNull();
	});

	it('returns null for an unrelated API path', () => {
		expect(extractVideoIdFromAudioPath('/api/stream-url/abc123')).toBeNull();
	});

	it('requires the extension to be at the end of the path, not just anywhere after it', () => {
		expect(extractVideoIdFromAudioPath('/cf-music/audio/abc123.webm/extra')).toBeNull();
	});
});

describe('coverCacheKey', () => {
	it('produces a stable key scoped to the videoId', () => {
		expect(coverCacheKey('abc123')).toBe('https://covers.cf-music.internal/abc123');
	});

	it('produces different keys for different videoIds', () => {
		expect(coverCacheKey('a')).not.toBe(coverCacheKey('b'));
	});

	it('never collides with an audioCacheKey for the same videoId', () => {
		expect(coverCacheKey('abc123')).not.toBe(audioCacheKey('abc123'));
	});
});

describe('extractVideoIdFromCoverPath', () => {
	it('extracts the videoId from a bucket-prefixed cover path', () => {
		expect(extractVideoIdFromCoverPath('/cf-music/covers/abc123.avif')).toBe('abc123');
	});

	it('returns null for an audio path (not under covers/)', () => {
		expect(extractVideoIdFromCoverPath('/cf-music/audio/abc123.webm')).toBeNull();
	});

	it('returns null for a path with no file extension', () => {
		expect(extractVideoIdFromCoverPath('/cf-music/covers/abc123')).toBeNull();
	});
});
