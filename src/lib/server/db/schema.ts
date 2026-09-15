import { sqliteTable, text, integer, primaryKey, index, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	username: text('username').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	storageQuotaBytes: integer('storage_quota_bytes').notNull().default(1_073_741_824), // 1GB
	autoEvictEnabled: integer('auto_evict_enabled', { mode: 'boolean' }).notNull().default(true),
	// Lazily created (see ensureDefaultPlaylist) the first time an import
	// doesn't specify a target playlist — null until then, not eagerly
	// created at registration, so a user who never imports anything never
	// gets a stray empty playlist.
	//
	// onDelete: 'set null' here is declarative intent, not an enforced DB
	// constraint: this column was added via ALTER TABLE ADD COLUMN (SQLite
	// can only attach real ON DELETE behavior in CREATE TABLE), so
	// deletePlaylist() clears this column itself before deleting a
	// playlist that happens to be someone's default — without that, it
	// would fail outright on a foreign key violation instead.
	defaultPlaylistId: text('default_playlist_id').references((): AnySQLiteColumn => playlists.id, {
		onDelete: 'set null'
	}),
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

	// Classification metadata: yt-dlp's own extracted fields (info['artist'],
	// info['album'], etc, falling back to info['uploader']/['channel'] for
	// artist on sources - most YouTube music uploads - that never set the
	// dedicated music fields), kept as-is rather than normalized/validated.
	// None of this is guaranteed present or accurate (a YouTube "uploader" is
	// a channel name, not necessarily a performer) - it's raw signal for
	// future auto-classification (by artist/genre/etc), not a verified taxonomy.
	artist: text('artist'),
	album: text('album'),
	genre: text('genre'),
	releaseYear: integer('release_year'),
	tags: text('tags'), // JSON array of strings, yt-dlp's info['tags']/['categories'] combined

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
	fatalError: text('fatal_error'), // set when the whole job failed before/outside the per-song loop (source extraction, WARP setup, etc.) — distinct from per-song entries in `failures`
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`),
	// Bumped on every progress-bearing write (start, preview, per-song
	// success/failure) — the only signal a scheduled sweep has for telling a
	// genuinely stuck job apart from one that's just slow. Defaults to
	// created_at's value so a job that dispatch-failed before ever reporting
	// progress is still eligible for the sweep rather than reading as
	// "just updated" from a null.
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(current_timestamp)`),
	completedAt: text('completed_at')
}, (t) => [index('idx_import_jobs_user_id').on(t.userId)]);

// Tracks storage a download has claimed but not yet committed to `songs` —
// closes the race where two concurrent imports for the same user both pass
// their own upfront "does this batch fit" check against the same starting
// usage figure and, together, exceed quota. A reservation is taken right
// before each song's download starts (not once per batch) and released
// exactly once, either into real usage (the song lands in `songs`) or back
// to nothing (the download failed/was cancelled) — see reserveQuota /
// releaseQuotaReservation in src/lib/server/import/quota-reservations.ts.
// Rows are scoped to one job so a crashed/killed CI process's abandoned
// reservations are easy to find and clean up via that job's own lifecycle
// (completion, cancellation, or the zombie-job auto-fail in the Durable
// Object) rather than needing to reconcile a drifting counter.
export const quotaReservations = sqliteTable('quota_reservations', {
	// (job_id, video_id) is the primary key, not a separate autoincrement
	// id — the whole point of this table is "at most one reservation per
	// song per job", enforced structurally rather than by a unique index
	// alongside an unrelated surrogate key.
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	jobId: text('job_id')
		.notNull()
		.references(() => importJobs.id, { onDelete: 'cascade' }),
	videoId: text('video_id').notNull(),
	estimatedBytes: integer('estimated_bytes').notNull(),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`)
}, (t) => [
	primaryKey({ columns: [t.jobId, t.videoId] }),
	index('idx_quota_reservations_user_id').on(t.userId)
]);

// Audit log: storage/auth/admin actions, admin-only visibility. No
// retention/cleanup mechanism exists — rows accumulate indefinitely (no
// Cron Trigger is configured in wrangler.jsonc, and nothing else in this
// codebase ever deletes from this table).
export const auditLog = sqliteTable('audit_log', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: text('user_id').references(() => users.id, { onDelete: 'set null' }), // the user the event relates to
	actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }), // who performed it (differs from userId when an admin acts on another user's behalf)
	eventType: text('event_type').notNull(), // import / evict / manual_delete / cover_reference_cleared /
	// login / login_failed / password_change / invite_used / invite_created / quota_adjusted / force_logout
	// (see AuditEventType in src/lib/server/audit/log.ts for the authoritative list)
	targetType: text('target_type'), // song / user / playlist
	targetId: text('target_id'),
	detail: text('detail'), // JSON blob with event-specific details
	ipAddress: text('ip_address'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`)
}, (t) => [index('idx_audit_log_created_at').on(t.createdAt)]);
