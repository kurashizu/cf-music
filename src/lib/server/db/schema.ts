import {
	sqliteTable,
	text,
	integer,
	blob,
	primaryKey,
	index,
	type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
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

	importedAt: text('imported_at')
		.notNull()
		.default(sql`(current_timestamp)`)
});

// Playlists: independent local entities disconnected from their source after import; also supports app-native playlists (sourceUrl is null)
//
// kind distinguishes user-owned playlists (fully editable — rename, delete,
// reorder, add/remove songs; this includes the default "All Imported"
// playlist, which is otherwise-editable but protected from being renamed/
// deleted itself, see assertPlaylistMutable) from ones a scheduled CI job
// generates (Artists groupings, play-history-based recommendations) —
// those are wholly read-only, rebuilt from scratch on each run rather than
// incrementally updated, so allowing any user edit on them would just be
// silently undone by the next run anyway.
export const playlists = sqliteTable(
	'playlists',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		sourceUrl: text('source_url'), // import source; null for app-native playlists
		kind: text('kind', { enum: ['user', 'auto_generated'] })
			.notNull()
			.default('user'),
		createdAt: text('created_at')
			.notNull()
			.default(sql`(current_timestamp)`)
	},
	(t) => [
		index('idx_playlists_user_id').on(t.userId),
		index('idx_playlists_user_id_kind').on(t.userId, t.kind)
	]
);

// Playlist<->song many-to-many; the same song can be referenced by multiple playlists, sharing one S3 object
export const playlistSongs = sqliteTable(
	'playlist_songs',
	{
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
	},
	(t) => [
		primaryKey({ columns: [t.playlistId, t.videoId] }),
		index('idx_playlist_songs_video_id').on(t.videoId),
		// addSongToPlaylist's `max(position) where playlist_id = ?` was a full
		// table scan of the whole playlist without this — the (playlistId,
		// videoId) primary key is ordered by videoId second, not position, so
		// it couldn't help SQLite jump straight to the max row.
		index('idx_playlist_songs_playlist_id_position').on(t.playlistId, t.position)
	]
);

// One row per (user, song) relationship: play history (the LFU+LRU blended
// eviction score input) and offline cache intent, merged together since
// both are just facets of "how this user relates to this song" — scoped
// per-user rather than being a global counter on `songs`: songs are
// deduplicated and shared across users, so a global play count let one
// user's heavy listening make a song look "popular" and eviction-resistant
// in a completely different user's library, even if that second user had
// never played it at all. Eviction always operates on one user's own
// library (see evictSongForUser), so its scoring input needs to be that
// same user's own history, not everyone's combined.
//
export const userSongs = sqliteTable(
	'user_songs',
	{
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		videoId: text('video_id')
			.notNull()
			.references(() => songs.videoId, { onDelete: 'cascade' }),
		playCount: integer('play_count').notNull().default(0),
		lastPlayedAt: text('last_played_at'),
		updatedAt: text('updated_at')
			.notNull()
			.default(sql`(current_timestamp)`)
	},
	(t) => [primaryKey({ columns: [t.userId, t.videoId] })]
);

// Import jobs: progress tracking across Worker <-> GitHub Actions <-> Durable Object
export const importJobs = sqliteTable(
	'import_jobs',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
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
		// A song already owned by someone (recordKnownSongLinked) is never
		// downloaded — it's linked into this job's target playlist as-is —
		// which is a meaningfully different outcome from completedCount (a real
		// new download landed) even though both count as "this job produced a
		// usable song" toward totalCount. Kept separate rather than folded into
		// completedCount so the UI can show "N skipped (already in library)"
		// distinctly from "N downloaded".
		knownCount: integer('known_count').notNull().default(0),
		failedCount: integer('failed_count').notNull().default(0),
		failures: text('failures'), // JSON array of failed video_id + reason entries
		// The user's total storage usage as of this job's last recomputation,
		// plus when that was taken. Caches an expensive query: computing usage
		// means summing file sizes across every song reachable from any of the
		// user's playlists, which reads the user's whole library — and
		// reserveQuota needs it once per song. Caching it per job turned a
		// per-song full-library scan into one scan per refresh window. Null
		// until this job first reserves anything. See getCachedUsageBytes in
		// src/lib/server/import/quota-reservations.ts for why a stale value is
		// safe here and when it gets refreshed.
		cachedUsageBytes: integer('cached_usage_bytes'),
		cachedUsageAt: text('cached_usage_at'),
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
	},
	(t) => [index('idx_import_jobs_user_id').on(t.userId)]
);

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
export const quotaReservations = sqliteTable(
	'quota_reservations',
	{
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
	},
	(t) => [
		primaryKey({ columns: [t.jobId, t.videoId] }),
		index('idx_quota_reservations_user_id').on(t.userId)
	]
);

// Audio-embedding jobs: one row per song, tracks whether its audio has been
// sent to the embedding model and written to Vectorize yet. Global (not
// per-user) since a song's audio content is the same regardless of who
// imported it — mirrors `songs` itself being deduplicated across users.
//
// Retries are deliberately NOT backed off within a single CI run: a job that
// fails with a retryable error (rate limit / embedding service unavailable)
// is just put back to 'pending' and picked up by the next scheduled workflow
// run, so the run interval (see .github/workflows/embedding.yml) IS the
// backoff. Non-retryable failures (bad/corrupt audio, unsupported format)
// go straight to 'failed' and are never retried automatically.
export const embeddingJobs = sqliteTable(
	'embedding_jobs',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		videoId: text('video_id')
			.notNull()
			.unique()
			.references(() => songs.videoId, { onDelete: 'cascade' }),
		status: text('status', {
			enum: ['pending', 'processing', 'done', 'failed']
		})
			.notNull()
			.default('pending'),
		attempts: integer('attempts').notNull().default(0),
		lastError: text('last_error'),
		createdAt: text('created_at')
			.notNull()
			.default(sql`(current_timestamp)`),
		updatedAt: text('updated_at')
			.notNull()
			.default(sql`(current_timestamp)`)
	},
	(t) => [index('idx_embedding_jobs_status').on(t.status)]
);

// Stores the raw embedding vector itself (768-dim float32, serialized as a
// blob — see src/lib/server/embedding/vector-codec.ts). Kept in D1 rather
// than Vectorize: similarity ranking only ever needs to run within one
// user's library (a few hundred songs), which Vectorize's ANN search isn't
// suited for (no way to scope a query to an arbitrary per-user song set),
// so the only thing Vectorize was buying us was billed-by-dimension reads
// we didn't need. Global (not per-user), same rationale as embeddingJobs.
export const songEmbeddings = sqliteTable('song_embeddings', {
	videoId: text('video_id')
		.primaryKey()
		.references(() => songs.videoId, { onDelete: 'cascade' }),
	vector: blob('vector', { mode: 'buffer' }).notNull(),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(current_timestamp)`)
});

// Audit log: storage/auth/admin actions, admin-only visibility. No
// retention/cleanup mechanism exists — rows accumulate indefinitely (no
// Cron Trigger is configured in wrangler.jsonc, and nothing else in this
// codebase ever deletes from this table).
export const auditLog = sqliteTable(
	'audit_log',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		userId: text('user_id').references(() => users.id, { onDelete: 'set null' }), // the user the event relates to
		actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }), // who performed it (differs from userId when an admin acts on another user's behalf)
		eventType: text('event_type').notNull(), // import / evict / manual_delete / cover_reference_cleared /
		// login / login_failed / password_change / invite_used / invite_created / quota_adjusted / force_logout /
		// embedding_claimed / embedding_completed / embedding_failed
		// (see AUDIT_EVENT_TYPES in src/lib/shared/audit-event-types.ts for the authoritative list — note:
		// a handful of existing rows use auto_tag_claimed/auto_tag_completed/auto_tag_playlists_rebuilt from
		// a reverted feature; those values are no longer in AUDIT_EVENT_TYPES but the historical rows remain)
		targetType: text('target_type'), // song / user / playlist / import_job / embedding_job
		targetId: text('target_id'),
		detail: text('detail'), // JSON blob with event-specific details
		ipAddress: text('ip_address'),
		createdAt: text('created_at')
			.notNull()
			.default(sql`(current_timestamp)`)
	},
	(t) => [index('idx_audit_log_created_at').on(t.createdAt)]
);
