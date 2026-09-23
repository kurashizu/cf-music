import { describe, it, expect } from 'vitest';
import {
	audioCacheKey,
	isCachedAudioOutdated,
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

describe('isCachedAudioOutdated', () => {
	const signed = (key: string) =>
		`https://s3api.example.com/cf-music/audio/${key}?X-Amz-Signature=abc&X-Amz-Expires=3600`;

	it('flags a WebM copy once the song is requested as MP4', () => {
		expect(isCachedAudioOutdated(signed('abc123.webm'), signed('abc123.m4a'))).toBe(true);
	});

	it('keeps a copy in the container being requested', () => {
		expect(isCachedAudioOutdated(signed('abc123.m4a'), signed('abc123.m4a'))).toBe(false);
	});

	it('ignores the signature, which differs on every request', () => {
		const other = signed('abc123.m4a').replace('abc&', 'xyz&');
		expect(isCachedAudioOutdated(signed('abc123.m4a'), other)).toBe(false);
	});

	it('compares extensions case-insensitively', () => {
		expect(isCachedAudioOutdated(signed('abc123.M4A'), signed('abc123.m4a'))).toBe(false);
	});

	it('keeps an entry with no recorded URL, having nothing to compare', () => {
		expect(isCachedAudioOutdated('', signed('abc123.m4a'))).toBe(false);
	});
});
