import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requireAdmin } from '$lib/server/auth/guard';
import { listAuditLog } from '$lib/server/audit/log';
import { AUDIT_EVENT_TYPES, type AuditEventType } from '$lib/shared/audit-event-types';

function pickNumber(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const db = getDb(event.platform!.env.DB);

	const params = event.url.searchParams;
	const eventTypesParam = params.get('eventTypes');
	const eventTypes = eventTypesParam
		? (eventTypesParam
				.split(',')
				.filter((t) => AUDIT_EVENT_TYPES.includes(t as AuditEventType)) as AuditEventType[])
		: undefined;

	return json(
		await listAuditLog(db, {
			limit: pickNumber(params.get('limit')),
			offset: pickNumber(params.get('offset')),
			eventTypes,
			search: params.get('search') ?? undefined,
			fromDate: params.get('from') ?? undefined,
			toDate: params.get('to') ?? undefined
		})
	);
};
