import { seedInviteCode } from './global-setup';

let counter = 0;

// Unique per-call so parallel-unsafe shared state (usernames, invite codes)
// never collides across tests, even though the suite runs with workers: 1.
export function uniqueSuffix(): string {
	counter += 1;
	return `${Date.now()}-${counter}`;
}

export function issueInviteCode(): string {
	const code = `e2e-code-${uniqueSuffix()}`;
	seedInviteCode(code);
	return code;
}
