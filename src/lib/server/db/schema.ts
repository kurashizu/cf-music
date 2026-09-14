import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	username: text('username').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	storageQuotaBytes: integer('storage_quota_bytes').notNull().default(1_073_741_824), // 1GB
	autoEvictEnabled: integer('auto_evict_enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`)
});

export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(), // random session token
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`),
	expiresAt: text('expires_at').notNull(),
	userAgent: text('user_agent'),
	ipAddress: text('ip_address')
}, (t) => [index('idx_sessions_user_id').on(t.userId)]);

export const inviteCodes = sqliteTable('invite_codes', {
	code: text('code').primaryKey(),
	createdBy: text('created_by')
		.notNull()
		.references(() => users.id),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`),
	usedBy: text('used_by').references(() => users.id),
	usedAt: text('used_at')
});

// Song library deduplicated by video_id, shared across platforms (source_platform stores yt-dlp's extractor value)
export const songs = sqliteTable('songs', {
	videoId: text('video_id').primaryKey(), // yt-dlp's id field; combined with extractor this should in theory be a composite unique key, but cross-platform id collisions are practically negligible, so video_id alone is the primary key for now
	sourcePlatform: text('source_platform').notNull(), // yt-dlp extractor, e.g. youtube / soundcloud
	sourceUrl: text('source_url').notNull(),
	title: text('title').notNull(),
	durationSeconds: integer('duration_seconds'),

	// Audio spec: actual measured values, no fixed-bitrate assumption (YouTube Opus varies ~46-167kbps in practice, not a flat 160kbps)
	audioKey: text('audio_key').notNull(), // S3 object key, e.g. audio/{video_id}.webm
	codec: text('codec').notNull(), // opus / aac / ...
	container: text('container').notNull(), // webm / m4a / ...
	bitrateKbps: integer('bitrate_kbps'),
	sampleRate: integer('sample_rate'),
	fileSizeBytes: integer('file_size_bytes').notNull(),

	// Cover art: ffmpeg-transcoded to AVIF CRF40, shares the audio's lifecycle
	coverKey: text('cover_key'), // S3 object key, e.g. covers/{video_id}.avif
	coverWidth: integer('cover_width'),
	coverHeight: integer('cover_height'),

	// LFU+LRU blended eviction score inputs
	playCount: integer('play_count').notNull().default(0),
	lastPlayedAt: text('last_played_at'),

	importedAt: text('imported_at')
		.notNull()
		.default(sql`(current_timestamp)`)
});

// Playlists: independent local entities disconnected from their source after import; also supports app-native playlists (sourceUrl is null)
export const playlists = sqliteTable('playlists', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	sourceUrl: text('source_url'), // import source; null for app-native playlists
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`)
}, (t) => [index('idx_playlists_user_id').on(t.userId)]);

// Playlist<->song many-to-many; the same song can be referenced by multiple playlists, sharing one S3 object
export const playlistSongs = sqliteTable('playlist_songs', {
	playlistId: text('playlist_id')
		.notNull()
		.references(() => playlists.id, { onDelete: 'cascade' }),
	videoId: text('video_id')
		.notNull()
		.references(() => songs.videoId, { onDelete: 'cascade' }),
	position: integer('position').notNull(), // user-adjustable playback order
	addedAt: text('added_at')
		.notNull()
		.default(sql`(current_timestamp)`)
}, (t) => [
	primaryKey({ columns: [t.playlistId, t.videoId] }),
	index('idx_playlist_songs_video_id').on(t.videoId)
]);

// Local cache markers: distinguishes lazy (evictable) caching from pinned (user-requested, never auto-cleared)
// Note: this table records "the user's caching intent" — actual IndexedDB contents are the browser's own source of truth and don't sync across devices
export const cachePreferences = sqliteTable('cache_preferences', {
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	videoId: text('video_id')
		.notNull()
		.references(() => songs.videoId, { onDelete: 'cascade' }),
	cacheType: text('cache_type', { enum: ['lazy', 'pinned'] }).notNull().default('lazy'),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(current_timestamp)`)
}, (t) => [primaryKey({ columns: [t.userId, t.videoId] })]);

// Import jobs: progress tracking across Worker <-> GitHub Actions <-> Durable Object
export const importJobs = sqliteTable('import_jobs', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	sourceUrl: text('source_url').notNull(),
	targetPlaylistId: text('target_playlist_id').references(() => playlists.id),
	status: text('status', {
		enum: ['pending', 'running', 'completed', 'failed', 'cancelled']
	})
		.notNull()
		.default('pending'),
	totalCount: integer('total_count'),
	completedCount: integer('completed_count').notNull().default(0),
	failedCount: integer('failed_count').notNull().default(0),
	failures: text('failures'), // JSON array of failed video_id + reason entries
	previewEntries: text('preview_entries'), // JSON array of {videoId, title, durationSeconds} found during extraction, informational only
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`),
	completedAt: text('completed_at')
}, (t) => [index('idx_import_jobs_user_id').on(t.userId)]);

// Audit log: storage/auth/admin actions, 30-day retention (cleaned up via a Cron Trigger), admin-only visibility
export const auditLog = sqliteTable('audit_log', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: text('user_id').references(() => users.id, { onDelete: 'set null' }), // the user the event relates to
	actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }), // who performed it (differs from userId when an admin acts on another user's behalf)
	eventType: text('event_type').notNull(), // import / evict / manual_delete / login / login_failed /
	// password_change / invite_used / invite_created / quota_adjusted / force_logout
	targetType: text('target_type'), // song / user / playlist
	targetId: text('target_id'),
	detail: text('detail'), // JSON blob with event-specific details
	ipAddress: text('ip_address'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`)
}, (t) => [index('idx_audit_log_created_at').on(t.createdAt)]);
