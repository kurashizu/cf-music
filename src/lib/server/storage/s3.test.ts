import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { S3ObjectStorage, MAX_KEYS_PER_DELETE_REQUEST } from './s3';

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

describe('deleteObjects', () => {
	let requests: Request[];
	let respond: () => Response;

	beforeEach(() => {
		requests = [];
		respond = () => new Response('<DeleteResult></DeleteResult>', { status: 200 });
		vi.stubGlobal('fetch', async (input: Request) => {
			requests.push(input);
			return respond();
		});
		// Node's WebCrypto has no MD5; workerd's does. Stand in for it here.
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
			if (algorithm === 'MD5') {
				const bytes = createHash('md5')
					.update(new Uint8Array(data as ArrayBuffer))
					.digest();
				return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			}
			return digest(algorithm, data);
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	/**
	 * The point of the change: a request's fetches are capped at 50 on the
	 * free plan, and deleting an account can mean thousands of objects.
	 */
	it('deletes a thousand keys per request rather than one', async () => {
		const keys = Array.from(
			{ length: 2 * MAX_KEYS_PER_DELETE_REQUEST + 1 },
			(_, i) => `audio/${i}.m4a`
		);

		await makeStorage().deleteObjects(keys);

		expect(requests).toHaveLength(3);
		for (const request of requests) {
			expect(request.method).toBe('POST');
			expect(new URL(request.url).searchParams.has('delete')).toBe(true);
		}
		const bodies = await Promise.all(requests.map((r) => r.text()));
		expect(bodies.map((b) => b.match(/<Key>/g)!.length)).toEqual([1000, 1000, 1]);
	});

	it('sends the MD5 of the body, which S3 requires for this call', async () => {
		await makeStorage().deleteObjects(['audio/a.m4a']);

		const body = await requests[0].clone().text();
		expect(requests[0].headers.get('content-md5')).toBe(
			createHash('md5').update(body).digest('base64')
		);
	});

	it('makes no request for nothing to delete', async () => {
		await makeStorage().deleteObjects([]);
		expect(requests).toHaveLength(0);
	});

	it('escapes keys so an ampersand cannot break the request', async () => {
		await makeStorage().deleteObjects(['covers/a&b<c>.avif']);
		expect(await requests[0].text()).toContain('<Key>covers/a&amp;b&lt;c&gt;.avif</Key>');
	});

	it('fails when the response reports keys it could not delete', async () => {
		respond = () =>
			new Response(
				'<DeleteResult><Error><Key>audio/x.m4a</Key><Code>AccessDenied</Code></Error></DeleteResult>',
				{ status: 200 }
			);
		await expect(makeStorage().deleteObjects(['audio/x.m4a'])).rejects.toThrow(
			'audio/x.m4a (AccessDenied)'
		);
	});

	it('fails on an error status', async () => {
		respond = () => new Response('denied', { status: 403, statusText: 'Forbidden' });
		await expect(makeStorage().deleteObjects(['audio/x.m4a'])).rejects.toThrow('403');
	});
});
