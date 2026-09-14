export const SESSION_COOKIE_NAME = 'session';

/** Options for `cookies.set`/`cookies.delete` (SvelteKit's Cookies API). */
export interface SessionCookieOptions {
	path: string;
	httpOnly: true;
	secure: true;
	sameSite: 'lax';
	expires?: Date;
	maxAge?: number;
}

export function sessionCookieOptions(expiresAt: Date): SessionCookieOptions {
	return {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		expires: expiresAt
	};
}

export function clearedSessionCookieOptions(): SessionCookieOptions {
	return {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: 0
	};
}
