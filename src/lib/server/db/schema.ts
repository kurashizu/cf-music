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

// 按 video_id 去重的曲目库，多平台通用（source_platform 存 yt-dlp 的 extractor 值）
export const songs = sqliteTable('songs', {
	videoId: text('video_id').primaryKey(), // yt-dlp 的 id 字段，配合 extractor 理论上应联合唯一，但实践中跨平台 id 冲突概率极低，先用 video_id 单独做主键
	sourcePlatform: text('source_platform').notNull(), // yt-dlp extractor，如 youtube / soundcloud
	sourceUrl: text('source_url').notNull(),
	title: text('title').notNull(),
	durationSeconds: integer('duration_seconds'),

	// 音频规格：实际值，不假设固定码率（YouTube Opus实测46-167kbps浮动，非固定160kbps）
	audioKey: text('audio_key').notNull(), // S3 object key，如 audio/{video_id}.webm
	codec: text('codec').notNull(), // opus / aac / ...
	container: text('container').notNull(), // webm / m4a / ...
	bitrateKbps: integer('bitrate_kbps'),
	sampleRate: integer('sample_rate'),
	fileSizeBytes: integer('file_size_bytes').notNull(),

	// 封面：ffmpeg转AVIF CRF40，与音频同构的生命周期
	coverKey: text('cover_key'), // S3 object key，如 covers/{video_id}.avif
	coverWidth: integer('cover_width'),
	coverHeight: integer('cover_height'),

	// LFU+LRU融合驱逐评分依据
	playCount: integer('play_count').notNull().default(0),
	lastPlayedAt: text('last_played_at'),

	importedAt: text('imported_at')
		.notNull()
		.default(sql`(current_timestamp)`)
});

// 播放列表：导入后与源断开关联的独立本地实体；也支持应用内自建歌单（sourceUrl为空）
export const playlists = sqliteTable('playlists', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	sourceUrl: text('source_url'), // 导入来源，自建歌单为空
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`)
}, (t) => [index('idx_playlists_user_id').on(t.userId)]);

// 播放列表<->曲目 多对多关系；同一首歌可被多个播放列表引用，共享同一个S3对象
export const playlistSongs = sqliteTable('playlist_songs', {
	playlistId: text('playlist_id')
		.notNull()
		.references(() => playlists.id, { onDelete: 'cascade' }),
	videoId: text('video_id')
		.notNull()
		.references(() => songs.videoId, { onDelete: 'cascade' }),
	position: integer('position').notNull(), // 用户可调整的播放顺序
	addedAt: text('added_at')
		.notNull()
		.default(sql`(current_timestamp)`)
}, (t) => [
	primaryKey({ columns: [t.playlistId, t.videoId] }),
	index('idx_playlist_songs_video_id').on(t.videoId)
]);

// 本地缓存标记：区分 lazy（懒缓存，可被驱逐跟随清理）与 pinned（用户手动预缓存，永不自动清除）
// 注意：这张表记录的是"用户希望缓存的意图"，实际IndexedDB内容以浏览器为准，跨设备不同步
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

// 导入任务：Worker <-> GitHub Actions <-> Durable Object 之间的进度追踪
export const importJobs = sqliteTable('import_jobs', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	sourceUrl: text('source_url').notNull(),
	targetPlaylistId: text('target_playlist_id').references(() => playlists.id),
	status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] })
		.notNull()
		.default('pending'),
	totalCount: integer('total_count'),
	completedCount: integer('completed_count').notNull().default(0),
	failedCount: integer('failed_count').notNull().default(0),
	failures: text('failures'), // JSON数组，记录失败的video_id+原因
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`),
	completedAt: text('completed_at')
}, (t) => [index('idx_import_jobs_user_id').on(t.userId)]);

// 审计日志：存储/认证/管理员操作，30天保留（配合Cron Trigger定期清理），仅管理员可见
export const auditLog = sqliteTable('audit_log', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: text('user_id').references(() => users.id, { onDelete: 'set null' }), // 事件relates to的用户
	actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }), // 谁执行的（管理员代操作时非userId本人）
	eventType: text('event_type').notNull(), // import / evict / manual_delete / login / login_failed /
	// password_change / invite_used / invite_created / quota_adjusted / force_logout
	targetType: text('target_type'), // song / user / playlist
	targetId: text('target_id'),
	detail: text('detail'), // JSON，事件相关的具体信息
	ipAddress: text('ip_address'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(current_timestamp)`)
}, (t) => [index('idx_audit_log_created_at').on(t.createdAt)]);
