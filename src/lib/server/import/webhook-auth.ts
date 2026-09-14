/**
 * Verifies the HMAC-SHA256 signature GitHub Actions attaches to import
 * callback requests, so the callback endpoint can't be spoofed by an
 * external party who doesn't know the shared secret.
 *
 * Signature format: `sha256=<hex>`, matching GitHub's own webhook
 * convention (HMAC-SHA256 of the raw request body, hex-encoded).
 */
export async function verifyWebhookSignature(
	rawBody: string,
	signatureHeader: string | null,
	secret: string
): Promise<boolean> {
	if (!signatureHeader) return false;

	const prefix = 'sha256=';
	if (!signatureHeader.startsWith(prefix)) return false;

	const providedHex = signatureHeader.slice(prefix.length);
	const expectedHex = await hmacSha256Hex(secret, rawBody);

	return timingSafeEqualHex(providedHex, expectedHex);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		// `extractable: false` only gates whether this key could later be
		// handed to crypto.subtle.exportKey()/wrapKey() — it has no effect on
		// sign(), the only operation performed here, so this flag's value is
		// behaviorally unobservable in this function (kept `false` anyway, as
		// the more conservative default for a key that's never re-exported).
		// Stryker disable next-line BooleanLiteral
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
	return Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;

	let diff = 0;
	for (const [i, char] of [...a].entries()) {
		diff |= char.charCodeAt(0) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
