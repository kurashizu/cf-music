// The list of audit event types, shared between the server (audit/log.ts,
// which owns writing/reading rows) and the browser client (the admin audit
// log page's filter UI). Kept under shared/ rather than server/ so the
// client-side filter dropdown can import the same list instead of
// re-declaring one that could drift out of sync.

export const AUDIT_EVENT_TYPES = [
	'import',
	'evict',
	'manual_delete',
	'cover_reference_cleared',
	'login',
	'login_failed',
	'password_change',
	'invite_used',
	'invite_created',
	'quota_adjusted',
	'force_logout',
	'embedding_claimed',
	'embedding_completed',
	'embedding_failed'
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
