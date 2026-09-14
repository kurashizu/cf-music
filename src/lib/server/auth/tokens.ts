const TOKEN_BYTES = 32;

function randomHex(byteLength: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export function generateSessionId(): string {
	return randomHex(TOKEN_BYTES);
}

/** Human-typeable invite code: 4 groups of 5 base32-ish chars, e.g. `A7K2M-9XQPZ-...`. */
export function generateInviteCode(): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid ambiguity
	const groups: string[] = [];
	for (let g = 0; g < 4; g++) {
		let group = '';
		const randomValues = crypto.getRandomValues(new Uint8Array(5));
		for (let i = 0; i < 5; i++) {
			group += alphabet[randomValues[i] % alphabet.length];
		}
		groups.push(group);
	}
	return groups.join('-');
}

export interface SessionExpiry {
	createdAt: Date;
	expiresAt: Date;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function computeSessionExpiry(now: Date = new Date()): SessionExpiry {
	return {
		createdAt: now,
		expiresAt: new Date(now.getTime() + SESSION_TTL_MS)
	};
}

export function isSessionExpired(expiresAt: Date, now: Date = new Date()): boolean {
	return now.getTime() >= expiresAt.getTime();
}
