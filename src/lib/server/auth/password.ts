// PBKDF2 via Web Crypto API — no native bindings, runs on Cloudflare Workers.
// Workers' crypto.subtle rejects PBKDF2 iteration counts above 100,000
// (NotSupportedError), which is below OWASP's current SHA-256 recommendation
// (600,000) — this is the platform ceiling, not a deliberately chosen value.
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function fromHex(hex: string): Uint8Array {
	// fromHex is only ever called on the salt segment, which parseStoredHash
	// immediately checks against SALT_BYTES (16). An empty match (`[]`, length
	// 0) and any single-element fallback array (length 1) both fail that
	// length check identically, so no input can observably distinguish this
	// fallback value — an equivalent mutant for the current SALT_BYTES.
	// Stryker disable next-line ArrayDeclaration
	const pairs = hex.match(/.{1,2}/g) ?? [];
	return new Uint8Array(pairs.map((pair) => parseInt(pair, 16)));
}

async function derive(
	password: string,
	salt: Uint8Array,
	iterations: number
): Promise<ArrayBuffer> {
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	return crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: salt as BufferSource,
			iterations,
			hash: 'SHA-256'
		},
		keyMaterial,
		HASH_BYTES * 8
	);
}

/** Returns `pbkdf2$<iterations>$<saltHex>$<hashHex>`. */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const derived = await derive(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt.buffer as ArrayBuffer)}$${toHex(derived)}`;
}

export interface ParsedStoredHash {
	iterations: number;
	salt: Uint8Array;
	expectedHex: string;
}

type HashSegments = [tag: string, iterationsRaw: string, saltHex: string, expectedHex: string];

function splitHashSegments(stored: string): HashSegments | null {
	const parts = stored.split('$');
	return parts.length === 4 ? (parts as HashSegments) : null;
}

function parseIterations(raw: string): number | null {
	const iterations = Number(raw);
	return Number.isInteger(iterations) && iterations > 0 ? iterations : null;
}

function isValidSaltAndHash(salt: Uint8Array, expectedHex: string): boolean {
	return salt.length === SALT_BYTES && expectedHex.length === HASH_BYTES * 2;
}

/**
 * Parses and validates the `pbkdf2$<iterations>$<saltHex>$<hashHex>` format,
 * returning `null` for any structurally invalid input. Kept separate from
 * `verifyPassword` so every guard clause is independently testable without
 * needing a real crypto round-trip for each malformed-input case.
 */
export function parseStoredHash(stored: string): ParsedStoredHash | null {
	const segments = splitHashSegments(stored);
	if (segments === null) return null;

	const [tag, iterationsRaw, saltHex, expectedHex] = segments;
	if (tag !== 'pbkdf2') return null;

	const iterations = parseIterations(iterationsRaw);
	if (iterations === null) return null;

	const salt = fromHex(saltHex);
	if (!isValidSaltAndHash(salt, expectedHex)) return null;

	return { iterations, salt, expectedHex };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parsed = parseStoredHash(stored);
	if (parsed === null) return false;

	const derived = await derive(password, parsed.salt, parsed.iterations);
	const actualHex = toHex(derived);

	return timingSafeEqual(actualHex, parsed.expectedHex);
}

/** Constant-time string comparison to avoid leaking hash contents via timing. */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;

	let diff = 0;
	for (const [i, char] of [...a].entries()) {
		diff |= char.charCodeAt(0) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
