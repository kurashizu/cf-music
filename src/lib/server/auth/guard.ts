import { error, type RequestEvent } from '@sveltejs/kit';
import type { AuthenticatedSession } from './service';

/** Throws a 401 if there's no valid session; otherwise returns it. */
export function requireSession(event: Pick<RequestEvent, 'locals'>): AuthenticatedSession {
	if (!event.locals.session) {
		error(401, 'Authentication required');
	}
	return event.locals.session;
}

/** Throws a 401/403 unless the caller is an authenticated admin. */
export function requireAdmin(event: Pick<RequestEvent, 'locals'>): AuthenticatedSession {
	const session = requireSession(event);
	if (!session.isAdmin) {
		error(403, 'Admin privileges required');
	}
	return session;
}
