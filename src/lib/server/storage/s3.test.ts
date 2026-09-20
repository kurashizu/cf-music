import { describe, it, expect } from 'vitest';
import { S3ObjectStorage } from './s3';

function makeStorage() {
	return new S3ObjectStorage({
		endpoint: 'https://s3.example.com',
		bucket: 'test-bucket',
		accessKeyId: 'test-access-key',
		secretAccessKey: 'test-secret-key'
	});
}

describe('presignGetUrl', () => {
	it('only lists real HTTP headers in SignedHeaders, not X-Amz-Expires', async () => {
		// X-Amz-Expires belongs in the query string for a presigned (signQuery)
		// URL, not as an HTTP header — passing it via `headers` instead (a past
		// bug here) makes the signing library treat it as a signable header
		// and add it to SignedHeaders, even though no such header is ever
		// actually sent with the GET request that follows. A real S3-compatible
		// server then rejects the request: it declares a header the request
		// doesn't have. This regression test would have caught that: 'host' is
		// the only header ever actually sent with a query-signed GET.
		const storage = makeStorage();
		const url = new URL(await storage.presignGetUrl('audio/some-song.webm'));

		const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
		expect(signedHeaders).toBe('host');
	});

	it('puts the expiry in the query string, not as a signed header', async () => {
		const storage = makeStorage();
		const url = new URL(await storage.presignGetUrl('audio/some-song.webm'));

		expect(url.searchParams.get('X-Amz-Expires')).toBe('86400');
	});

	it('points at the requested object key under the configured bucket', async () => {
		const storage = makeStorage();
		const url = new URL(await storage.presignGetUrl('covers/some-song.avif'));

		expect(url.origin + url.pathname).toBe(
			'https://s3.example.com/test-bucket/covers/some-song.avif'
		);
	});
});
