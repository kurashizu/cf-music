import { and, desc, gte, inArray, like, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { auditLog, users } from '../db/schema';
import type { AuditEventType } from '../../shared/audit-event-types';

export interface AuditEntry {
	userId?: string | null;
	actorId?: string | null;
	eventType: AuditEventType;
	targetType?: 'song' | 'playlist' | 'user' | 'import_job' | 'embedding_job' | null;
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
	offset?: number;
	/** OR'd together — an entry matching any listed type passes. Omit/empty for "all types". */
	eventTypes?: AuditEventType[];
	/** Inclusive; ISO date/datetime string, compared against created_at as-is (both are UTC ISO text). */
	fromDate?: string;
	/** Inclusive. */
	toDate?: string;
	/**
	 * Free-text search across everything a human would actually search
	 * by: resolved username (via a username -> id lookup, since userId/
	 * actorId are stored as opaque UUIDs no one would type), event type,
	 * target type/id, ip address, and the raw detail JSON blob (so e.g.
	 * a videoId or error message embedded in detail is still findable).
	 */
	search?: string;
}

export interface AuditLogPage {
	entries: Awaited<ReturnType<typeof enrichWithUsernames>>;
	total: number;
}

/**
 * Lists audit events, most recent first — admin-only per the schema's own
 * design comment. Every filter is applied in SQL (not just fetched then
 * filtered in memory) so pagination/total counts stay correct as this
 * table grows without bound (see its own no-retention design comment in
 * schema.ts) — the one exception is matching `search` against a
 * *username*, which needs a users lookup first since userId/actorId are
 * opaque UUIDs.
 */
export async function listAuditLog(db: Db, options: ListAuditLogOptions = {}): Promise<AuditLogPage> {
	const limit = Math.min(options.limit ?? DEFAULT_AUDIT_LOG_PAGE_SIZE, MAX_AUDIT_LOG_PAGE_SIZE);
	const offset = Math.max(options.offset ?? 0, 0);

	const conditions = [];
	if (options.eventTypes && options.eventTypes.length > 0) {
		conditions.push(inArray(auditLog.eventType, options.eventTypes));
	}
	if (options.fromDate) conditions.push(gte(auditLog.createdAt, options.fromDate));
	if (options.toDate) conditions.push(lte(auditLog.createdAt, options.toDate));

	const search = options.search?.trim();
	if (search) {
		const pattern = `%${search}%`;
		const matchingUserIds = await db.query.users.findMany({
			where: like(users.username, pattern),
			columns: { id: true }
		});
		const searchConditions = [
			like(auditLog.eventType, pattern),
			like(auditLog.targetType, pattern),
			like(auditLog.targetId, pattern),
			like(auditLog.ipAddress, pattern),
			like(auditLog.detail, pattern)
		];
		if (matchingUserIds.length > 0) {
			const ids = matchingUserIds.map((u) => u.id);
			searchConditions.push(inArray(auditLog.userId, ids), inArray(auditLog.actorId, ids));
		}
		conditions.push(or(...searchConditions)!);
	}

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const [entries, totalResult] = await Promise.all([
		db.query.auditLog.findMany({
			where,
			orderBy: desc(auditLog.createdAt),
			limit,
			offset
		}),
		db
			.select({ count: sql<number>`count(*)` })
			.from(auditLog)
			.where(where)
	]);

	return { entries: await enrichWithUsernames(db, entries), total: totalResult[0].count };
}

/**
 * Resolves userId/actorId to usernames (and targetId too, when targetType
 * is 'user') so the admin UI never has to show a bare UUID for "who did
 * this" — the raw ids stay on the entry as well, for anything that needs
 * them (e.g. linking to the user's own row).
 */
async function enrichWithUsernames(db: Db, entries: (typeof auditLog.$inferSelect)[]) {
	const userIds = new Set<string>();
	for (const entry of entries) {
		if (entry.userId) userIds.add(entry.userId);
		if (entry.actorId) userIds.add(entry.actorId);
		if (entry.targetType === 'user' && entry.targetId) userIds.add(entry.targetId);
	}

	const usernameById = new Map<string, string>();
	if (userIds.size > 0) {
		const rows = await db.query.users.findMany({
			where: inArray(users.id, [...userIds]),
			columns: { id: true, username: true }
		});
		for (const row of rows) usernameById.set(row.id, row.username);
	}

	// Falls back to null (not the raw id) when a referenced user has since
	// been deleted — the FK is ON DELETE SET NULL for userId/actorId, but a
	// deleted user's id can still live on in a past entry's targetId, which
	// has no such constraint at all (targetId is a plain, unconstrained
	// column shared across every targetType).
	return entries.map((entry) => ({
		...entry,
		username: entry.userId ? (usernameById.get(entry.userId) ?? null) : null,
		actorUsername: entry.actorId ? (usernameById.get(entry.actorId) ?? null) : null,
		targetUsername:
			entry.targetType === 'user' && entry.targetId
				? usernameById.get(entry.targetId) ?? null
				: null
	}));
}
