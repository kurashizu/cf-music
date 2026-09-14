import { desc } from 'drizzle-orm';
import type { Db } from '../db';
import { auditLog } from '../db/schema';

export type AuditEventType =
	| 'import'
	| 'evict'
	| 'manual_delete'
	| 'login'
	| 'login_failed'
	| 'password_change'
	| 'invite_used'
	| 'invite_created'
	| 'quota_adjusted'
	| 'force_logout';

export interface AuditEntry {
	userId?: string | null;
	actorId?: string | null;
	eventType: AuditEventType;
	targetType?: 'song' | 'playlist' | 'user' | null;
	targetId?: string | null;
	detail?: unknown;
	ipAddress?: string | null;
}

export async function recordAuditEvent(db: Db, entry: AuditEntry): Promise<void> {
	await db.insert(auditLog).values({
		userId: entry.userId ?? null,
		actorId: entry.actorId ?? null,
		eventType: entry.eventType,
		targetType: entry.targetType ?? null,
		targetId: entry.targetId ?? null,
		detail: entry.detail !== undefined ? JSON.stringify(entry.detail) : null,
		ipAddress: entry.ipAddress ?? null
	});
}

const DEFAULT_AUDIT_LOG_PAGE_SIZE = 50;
const MAX_AUDIT_LOG_PAGE_SIZE = 200;

export interface ListAuditLogOptions {
	limit?: number;
}

/** Lists audit events, most recent first — admin-only per the schema's own design comment. */
export async function listAuditLog(db: Db, options: ListAuditLogOptions = {}) {
	const limit = Math.min(options.limit ?? DEFAULT_AUDIT_LOG_PAGE_SIZE, MAX_AUDIT_LOG_PAGE_SIZE);

	return db.query.auditLog.findMany({
		orderBy: desc(auditLog.createdAt),
		limit
	});
}
