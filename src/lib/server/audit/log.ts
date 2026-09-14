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
