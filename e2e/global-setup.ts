import { execFileSync } from 'node:child_process';

export const E2E_SEED_ADMIN_ID = 'e2e-seed-admin';

export function d1Execute(sql: string) {
	execFileSync('npx', ['wrangler', 'd1', 'execute', 'cf-music', '--local', '--command', sql], {
		stdio: ['ignore', 'ignore', 'inherit']
	});
}

export function seedInviteCode(code: string) {
	d1Execute(
		`INSERT INTO invite_codes (code, created_by, created_at)
		 VALUES ('${code}', '${E2E_SEED_ADMIN_ID}', datetime('now'));`
	);
}

/**
 * Sessions moved from D1 to KV (see src/lib/server/auth/sessions.ts) — this
 * wipes every key in the local SESSION_KV namespace `wrangler dev` uses
 * (see playwright.config.ts's webServer). Not scoped to a specific key
 * prefix since nothing else in the app uses this namespace.
 */
function clearLocalSessionKv() {
	const raw = execFileSync(
		'npx',
		['wrangler', 'kv', 'key', 'list', '--binding', 'SESSION_KV', '--local', '--preview', 'false'],
		{ stdio: ['ignore', 'pipe', 'inherit'] }
	).toString();
	const keys: { name: string }[] = JSON.parse(raw);
	for (const { name } of keys) {
		execFileSync(
			'npx',
			[
				'wrangler',
				'kv',
				'key',
				'delete',
				'--binding',
				'SESSION_KV',
				'--local',
				'--preview',
				'false',
				name
			],
			{
				stdio: ['ignore', 'ignore', 'inherit']
			}
		);
	}
}

// Runs once before the whole Playwright suite: wipes prior E2E rows and
// seeds a bootstrap admin so per-test invite codes can satisfy the
// invite_codes.created_by FK without a real admin account existing.
export default function globalSetup() {
	clearLocalSessionKv();
	// users.default_playlist_id references playlists.id (see schema.ts) —
	// cleared before deleting playlists below, or a leftover e2e user (from
	// a prior run's import test, which calls ensureDefaultPlaylist) whose
	// default is one of the playlists about to be deleted violates that
	// foreign key.
	d1Execute(`UPDATE users SET default_playlist_id = NULL WHERE username LIKE 'e2e-%';`);
	// import_jobs.target_playlist_id references playlists.id with no ON
	// DELETE behavior (see schema.ts) — a leftover e2e import job (from a
	// prior run's import test, which always fails locally since there's no
	// real GitHub token, but still gets created with a real target
	// playlist) blocks deleting that playlist below just the same way.
	d1Execute(
		`DELETE FROM import_jobs WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'e2e-%');`
	);
	d1Execute(`DELETE FROM playlist_songs WHERE video_id LIKE 'e2e-song-%';`);
	d1Execute(`DELETE FROM songs WHERE video_id LIKE 'e2e-song-%';`);
	d1Execute(
		`DELETE FROM playlists WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'e2e-%');`
	);
	// invite_codes.created_by/used_by have no ON DELETE behavior, so any code
	// created or claimed by a leftover e2e-* user (from a prior interrupted
	// run) would block deleting that user below.
	d1Execute(
		`DELETE FROM invite_codes WHERE created_by = '${E2E_SEED_ADMIN_ID}' OR created_by IN (SELECT id FROM users WHERE username LIKE 'e2e-%') OR used_by IN (SELECT id FROM users WHERE username LIKE 'e2e-%');`
	);
	d1Execute(`DELETE FROM users WHERE id = '${E2E_SEED_ADMIN_ID}' OR username LIKE 'e2e-%';`);
	d1Execute(
		`INSERT INTO users (id, username, password_hash, is_admin, storage_quota_bytes, auto_evict_enabled, created_at)
		 VALUES ('${E2E_SEED_ADMIN_ID}', '${E2E_SEED_ADMIN_ID}', 'unused', 1, 1073741824, 1, datetime('now'));`
	);
}
