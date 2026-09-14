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

// Runs once before the whole Playwright suite: wipes prior E2E rows and
// seeds a bootstrap admin so per-test invite codes can satisfy the
// invite_codes.created_by FK without a real admin account existing.
export default function globalSetup() {
	d1Execute(`DELETE FROM sessions;`);
	d1Execute(`DELETE FROM playlist_songs WHERE video_id LIKE 'e2e-song-%';`);
	d1Execute(`DELETE FROM songs WHERE video_id LIKE 'e2e-song-%';`);
	d1Execute(`DELETE FROM playlists WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'e2e-%');`);
	d1Execute(`DELETE FROM invite_codes WHERE created_by = '${E2E_SEED_ADMIN_ID}';`);
	d1Execute(`DELETE FROM users WHERE id = '${E2E_SEED_ADMIN_ID}' OR username LIKE 'e2e-%';`);
	d1Execute(
		`INSERT INTO users (id, username, password_hash, is_admin, storage_quota_bytes, auto_evict_enabled, created_at)
		 VALUES ('${E2E_SEED_ADMIN_ID}', '${E2E_SEED_ADMIN_ID}', 'unused', 1, 1073741824, 1, datetime('now'));`
	);
}
