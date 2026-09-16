import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listAuditLog } from '$lib/server/audit/log';
import { AUDIT_EVENT_TYPES, type AuditEventType } from '$lib/shared/audit-event-types';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ platform, locals, url }) => {
	if (!locals.session) {
		redirect(303, '/');
	}
	if (!locals.session.isAdmin) {
		redirect(303, '/library');
	}

	const db = getDb(platform!.env.DB);

	const eventTypesParam = url.searchParams.get('eventTypes');
	const eventTypes = eventTypesParam
		? (eventTypesParam.split(',').filter((t) => AUDIT_EVENT_TYPES.includes(t as AuditEventType)) as AuditEventType[])
		: undefined;

	const page = Math.max(Number(url.searchParams.get('page')) || 1, 1);
	const search = url.searchParams.get('search') ?? undefined;
	const fromDate = url.searchParams.get('from') ?? undefined;
	const toDate = url.searchParams.get('to') ?? undefined;

	const { entries, total } = await listAuditLog(db, {
		limit: PAGE_SIZE,
		offset: (page - 1) * PAGE_SIZE,
		eventTypes,
		search,
		fromDate,
		toDate
	});

	return {
		entries,
		total,
		page,
		pageSize: PAGE_SIZE,
		eventTypes: eventTypes ?? [],
		search: search ?? '',
		fromDate: fromDate ?? '',
		toDate: toDate ?? ''
	};
};
