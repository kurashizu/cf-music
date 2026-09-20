import { describe, it, expect } from 'vitest';
import { verifyWebhookSignature } from './webhook-auth';

async function sign(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	const hex = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `sha256=${hex}`;
}

describe('verifyWebhookSignature', () => {
	it('accepts a correctly signed body', async () => {
		const secret = 'shared-secret';
		const body = '{"jobId":"abc"}';
		const header = await sign(secret, body);

		await expect(verifyWebhookSignature(body, header, secret)).resolves.toBe(true);
	});

	it('rejects a body that was tampered with after signing', async () => {
		const secret = 'shared-secret';
		const header = await sign(secret, '{"jobId":"abc"}');

		await expect(verifyWebhookSignature('{"jobId":"tampered"}', header, secret)).resolves.toBe(
			false
		);
	});

	it('rejects a signature produced with the wrong secret', async () => {
		const body = '{"jobId":"abc"}';
		const header = await sign('wrong-secret', body);

		await expect(verifyWebhookSignature(body, header, 'shared-secret')).resolves.toBe(false);
	});

	it('rejects a missing signature header', async () => {
		await expect(verifyWebhookSignature('{}', null, 'shared-secret')).resolves.toBe(false);
	});

	it('rejects a header missing the "sha256=" prefix, even when the remainder happens to be the correct signature', async () => {
		// Isolates the `startsWith(prefix)` guard: prepend exactly
		// prefix.length (7) filler characters ahead of the real signature, so
		// that skipping the guard and blindly slicing off the first 7 chars
		// would (incorrectly) recover the correct hex and pass.
		const secret = 'shared-secret';
		const body = '{}';
		const header = await sign(secret, body);
		const correctHex = header.slice('sha256='.length);
		const missingPrefix = 'XXXXXXX' + correctHex; // 7 filler chars, not "sha256="

		await expect(verifyWebhookSignature(body, missingPrefix, secret)).resolves.toBe(false);
	});

	it('rejects a header missing the "sha256=" prefix', async () => {
		const secret = 'shared-secret';
		const body = '{}';
		const { hex } = await (async () => {
			const key = await crypto.subtle.importKey(
				'raw',
				new TextEncoder().encode(secret),
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['sign']
			);
			const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
			return {
				hex: Array.from(new Uint8Array(sig))
					.map((b) => b.toString(16).padStart(2, '0'))
					.join('')
			};
		})();

		await expect(verifyWebhookSignature(body, hex, secret)).resolves.toBe(false);
	});

	it('rejects a hex signature of the wrong length', async () => {
		await expect(verifyWebhookSignature('{}', 'sha256=abc', 'shared-secret')).resolves.toBe(false);
	});

	it('rejects a shorter hex signature that is an exact prefix of the correct one', async () => {
		// Isolates the length guard in timingSafeEqualHex: if it were skipped,
		// comparing only up to the shorter string's length would find no
		// differing characters and incorrectly report equality.
		const secret = 'shared-secret';
		const body = '{}';
		const header = await sign(secret, body);
		const correctHex = header.slice('sha256='.length);
		const truncated = `sha256=${correctHex.slice(0, -1)}`;

		await expect(verifyWebhookSignature(body, truncated, secret)).resolves.toBe(false);
	});

	it('rejects a well-formed but incorrect signature that happens to share a prefix with the correct one', async () => {
		const secret = 'shared-secret';
		const body = '{}';
		const correct = await sign(secret, body);
		const tamperedLastChar = correct.slice(0, -1) + (correct.endsWith('a') ? 'b' : 'a');

		await expect(verifyWebhookSignature(body, tamperedLastChar, secret)).resolves.toBe(false);
	});
});
