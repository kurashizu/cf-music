import { describe, expect, it } from 'vitest';
import { sliceRangeFromCachedResponse } from './range-slice';

function makeCachedResponse(byteLength: number): Response {
	const bytes = new Uint8Array(byteLength);
	for (let i = 0; i < byteLength; i++) bytes[i] = i % 256;
	return new Response(bytes, { status: 200, headers: { 'content-type': 'audio/webm' } });
}

async function bodyBytes(response: Response): Promise<number[]> {
	return [...new Uint8Array(await response.arrayBuffer())];
}

describe('sliceRangeFromCachedResponse', () => {
	it('slices an explicit bytes=start-end range', async () => {
		const result = await sliceRangeFromCachedResponse(makeCachedResponse(1000), 'bytes=100-199');

		expect(result?.status).toBe(206);
		expect(result?.headers.get('Content-Range')).toBe('bytes 100-199/1000');
		expect(result?.headers.get('Content-Length')).toBe('100');
		expect(await bodyBytes(result!)).toEqual(
			Array.from({ length: 100 }, (_, i) => (100 + i) % 256)
		);
	});

	it('slices an open-ended bytes=start- range (from start to EOF, the common seek case)', async () => {
		const result = await sliceRangeFromCachedResponse(makeCachedResponse(1000), 'bytes=900-');

		expect(result?.status).toBe(206);
		expect(result?.headers.get('Content-Range')).toBe('bytes 900-999/1000');
		expect((await bodyBytes(result!)).length).toBe(100);
	});

	it('slices a suffix bytes=-N range (last N bytes)', async () => {
		const result = await sliceRangeFromCachedResponse(makeCachedResponse(1000), 'bytes=-50');

		expect(result?.status).toBe(206);
		expect(result?.headers.get('Content-Range')).toBe('bytes 950-999/1000');
		expect((await bodyBytes(result!)).length).toBe(50);
	});

	it('clamps an explicit end beyond the actual length to the last byte', async () => {
		const result = await sliceRangeFromCachedResponse(makeCachedResponse(1000), 'bytes=900-99999');

		expect(result?.headers.get('Content-Range')).toBe('bytes 900-999/1000');
	});

	it('preserves the original content-type header on the sliced response', async () => {
		const result = await sliceRangeFromCachedResponse(makeCachedResponse(1000), 'bytes=0-99');

		expect(result?.headers.get('content-type')).toBe('audio/webm');
	});

	it('returns null for a header it cannot parse', async () => {
		const result = await sliceRangeFromCachedResponse(
			makeCachedResponse(1000),
			'not-a-range-header'
		);

		expect(result).toBeNull();
	});

	it('returns null for a suffix range with no length (bytes=-)', async () => {
		const result = await sliceRangeFromCachedResponse(makeCachedResponse(1000), 'bytes=-');

		expect(result).toBeNull();
	});

	it('returns null when the requested start is at or past the end of the cached file', async () => {
		const result = await sliceRangeFromCachedResponse(makeCachedResponse(1000), 'bytes=1000-1099');

		expect(result).toBeNull();
	});

	it('returns null when start is after end', async () => {
		const result = await sliceRangeFromCachedResponse(makeCachedResponse(1000), 'bytes=500-100');

		expect(result).toBeNull();
	});
});
