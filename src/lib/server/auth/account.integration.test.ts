import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { auditLog, playlists, playlistSongs, songs, userSongs, users } from '../db/schema';
import { login, resolveSession, AuthError } from './service';
import { hashPassword } from './password';
import {
	changeOwnPassword,
	adminResetPassword,
	forceLogout,
	setUserAdmin,
	setUserDisabled,
	deleteUser
} from './account';
import { addSongToPlaylist, createPlaylist } from '../library/playlists';

const db = getDb(env);
const kv = env.SESSION_KV;

/** Records every key it was asked to delete, so tests can assert on storage effects. */
function fakeStorage() {
	const deleted: string[] = [];
	return {
		deleted,
		storage: {
			deleteObjects: async (keys: string[]) => {
				deleted.push(...keys);
			}
		} as unknown as Parameters<typeof deleteUser>[2]
	};
}

async function seedUser(
	id: string,
	options: { password?: string; isAdmin?: boolean } = {}
): Promise<void> {
	await db.insert(users).values({
		id,
		username: `user-${id}`,
		passwordHash: await hashPassword(options.password ?? 'correct-password'),
		isAdmin: options.isAdmin ?? false
	});
}

async function seedSong(videoId: string): Promise<void> {
	await db
		.insert(songs)
		.values({
			videoId,
			sourcePlatform: 'youtube',
			sourceUrl: `https://youtube.com/watch?v=${videoId}`,
			title: `Song ${videoId}`,
			audioKey: `audio/${videoId}.webm`,
			coverKey: `cover/${videoId}.jpg`,
			codec: 'opus',
			container: 'webm',
			fileSizeBytes: 1000
		})
		.onConflictDoNothing();
}

async function clearAllKeys(): Promise<void> {
	const { keys } = await kv.list();
	await Promise.all(keys.map((k) => kv.delete(k.name)));
}

beforeEach(async () => {
	await db.delete(auditLog);
	await db.delete(playlistSongs);
	await db.delete(userSongs);
	await db.update(users).set({ defaultPlaylistId: null });
	await db.delete(playlists);
	await db.delete(songs);
	await db.delete(users);
	await clearAllKeys();
	// audit_log.actor_id is a real foreign key, so every action needs an
	// actor that exists. Seeded here rather than per test because all of
	// these record an audit entry.
	await seedUser('admin', { isAdmin: true });
});

describe('changeOwnPassword', () => {
	it('rejects a wrong current password', async () => {
		await seedUser('u1');
		await expect(
			changeOwnPassword(db, kv, {
				userId: 'u1',
				currentPassword: 'not-it',
				newPassword: 'brand-new-password'
			})
		).rejects.toThrow(AuthError);
	});

	it('lets the new password log in afterwards', async () => {
		await seedUser('u1');
		await changeOwnPassword(db, kv, {
			userId: 'u1',
			currentPassword: 'correct-password',
			newPassword: 'brand-new-password'
		});

		await expect(
			login(db, kv, { username: 'user-u1', password: 'brand-new-password' })
		).resolves.toMatchObject({ userId: 'u1' });
	});

	it('stops the old password working', async () => {
		await seedUser('u1');
		await changeOwnPassword(db, kv, {
			userId: 'u1',
			currentPassword: 'correct-password',
			newPassword: 'brand-new-password'
		});

		await expect(
			login(db, kv, { username: 'user-u1', password: 'correct-password' })
		).rejects.toThrow(AuthError);
	});

	// The reason to change a password is usually that someone else may know
	// it, so leaving their sessions alive would defeat the exercise.
	it('invalidates sessions that existed before the change', async () => {
		await seedUser('u1');
		const { sessionId } = await login(db, kv, {
			username: 'user-u1',
			password: 'correct-password'
		});

		await changeOwnPassword(db, kv, {
			userId: 'u1',
			currentPassword: 'correct-password',
			newPassword: 'brand-new-password'
		});

		await expect(resolveSession(db, kv, sessionId)).rejects.toThrow(AuthError);
	});
});

describe('adminResetPassword', () => {
	it('sets a password without needing the old one', async () => {
		await seedUser('u1');
		await adminResetPassword(db, kv, {
			actorId: 'admin',
			targetUserId: 'u1',
			newPassword: 'admin-chosen-password'
		});

		await expect(
			login(db, kv, { username: 'user-u1', password: 'admin-chosen-password' })
		).resolves.toMatchObject({ userId: 'u1' });
	});

	it('signs the user out of their existing sessions', async () => {
		await seedUser('u1');
		const { sessionId } = await login(db, kv, {
			username: 'user-u1',
			password: 'correct-password'
		});

		await adminResetPassword(db, kv, {
			actorId: 'admin',
			targetUserId: 'u1',
			newPassword: 'admin-chosen-password'
		});

		await expect(resolveSession(db, kv, sessionId)).rejects.toThrow(AuthError);
	});
});

describe('forceLogout', () => {
	it('ends existing sessions but leaves the password working', async () => {
		await seedUser('u1');
		const { sessionId } = await login(db, kv, {
			username: 'user-u1',
			password: 'correct-password'
		});

		await forceLogout(db, kv, { actorId: 'admin', targetUserId: 'u1' });

		await expect(resolveSession(db, kv, sessionId)).rejects.toThrow(AuthError);
		await expect(
			login(db, kv, { username: 'user-u1', password: 'correct-password' })
		).resolves.toMatchObject({ userId: 'u1' });
	});
});

describe('setUserDisabled', () => {
	it('stops a disabled user logging in', async () => {
		await seedUser('u1');

		await setUserDisabled(db, kv, { actorId: 'admin', targetUserId: 'u1', disabled: true });

		await expect(
			login(db, kv, { username: 'user-u1', password: 'correct-password' })
		).rejects.toThrow(AuthError);
	});

	// Disabling that only took effect at the next login would leave a
	// suspended account working for however long its session had left.
	it('invalidates a session the user already held', async () => {
		await seedUser('u1');
		const { sessionId } = await login(db, kv, {
			username: 'user-u1',
			password: 'correct-password'
		});

		await setUserDisabled(db, kv, { actorId: 'admin', targetUserId: 'u1', disabled: true });

		await expect(resolveSession(db, kv, sessionId)).rejects.toThrow(AuthError);
	});

	it('lets a re-enabled user back in with the same password', async () => {
		await seedUser('u1');
		await setUserDisabled(db, kv, { actorId: 'admin', targetUserId: 'u1', disabled: true });
		await setUserDisabled(db, kv, { actorId: 'admin', targetUserId: 'u1', disabled: false });

		await expect(
			login(db, kv, { username: 'user-u1', password: 'correct-password' })
		).resolves.toMatchObject({ userId: 'u1' });
	});

	it('refuses to let an admin disable themselves', async () => {
		await expect(
			setUserDisabled(db, kv, { actorId: 'admin', targetUserId: 'admin', disabled: true })
		).rejects.toThrow(AuthError);
	});

	// An instance whose only admin is locked out cannot be recovered from
	// inside the app at all.
	it('refuses to disable the last remaining admin', async () => {
		await seedUser('other-admin', { isAdmin: true });

		await setUserDisabled(db, kv, {
			actorId: 'admin',
			targetUserId: 'other-admin',
			disabled: true
		});
		// 'admin' is now the only one left, so the same call must fail.
		await expect(
			setUserDisabled(db, kv, { actorId: 'other-admin', targetUserId: 'admin', disabled: true })
		).rejects.toThrow(AuthError);
	});
});

describe('setUserAdmin', () => {
	it('promotes and demotes', async () => {
		await seedUser('u1');

		await setUserAdmin(db, { actorId: 'admin', targetUserId: 'u1', isAdmin: true });
		expect((await db.query.users.findFirst({ where: eq(users.id, 'u1') }))?.isAdmin).toBe(true);

		await setUserAdmin(db, { actorId: 'admin', targetUserId: 'u1', isAdmin: false });
		expect((await db.query.users.findFirst({ where: eq(users.id, 'u1') }))?.isAdmin).toBe(false);
	});

	it('refuses to demote the last admin', async () => {
		await expect(
			setUserAdmin(db, { actorId: 'admin', targetUserId: 'admin', isAdmin: false })
		).rejects.toThrow(AuthError);
	});
});

describe('deleteUser', () => {
	it('removes the user and their playlists', async () => {
		await seedUser('u1');
		const { id: playlistId } = await createPlaylist(db, { userId: 'u1', name: 'Mine' });
		const { storage } = fakeStorage();

		await deleteUser(db, kv, storage, { actorId: 'admin', targetUserId: 'u1' });

		expect(await db.query.users.findFirst({ where: eq(users.id, 'u1') })).toBeUndefined();
		expect(
			await db.query.playlists.findFirst({ where: eq(playlists.id, playlistId) })
		).toBeUndefined();
	});

	it('deletes a song only that user had, and its stored objects', async () => {
		await seedUser('u1');
		await seedSong('only-theirs');
		const { id } = await createPlaylist(db, { userId: 'u1', name: 'Mine' });
		await addSongToPlaylist(db, id, 'u1', 'only-theirs');
		const { storage, deleted } = fakeStorage();

		await deleteUser(db, kv, storage, { actorId: 'admin', targetUserId: 'u1' });

		expect(
			await db.query.songs.findFirst({ where: eq(songs.videoId, 'only-theirs') })
		).toBeUndefined();
		expect(deleted).toContain('audio/only-theirs.webm');
	});

	// `songs` rows are shared between users who imported the same video, so
	// a departing user must not take one out from under someone else.
	it('keeps a song another user still has in a playlist', async () => {
		await seedUser('u1');
		await seedUser('u2');
		await seedSong('shared');
		const { id: theirs } = await createPlaylist(db, { userId: 'u1', name: 'Theirs' });
		const { id: others } = await createPlaylist(db, { userId: 'u2', name: 'Others' });
		await addSongToPlaylist(db, theirs, 'u1', 'shared');
		await addSongToPlaylist(db, others, 'u2', 'shared');
		const { storage, deleted } = fakeStorage();

		await deleteUser(db, kv, storage, { actorId: 'admin', targetUserId: 'u1' });

		expect(await db.query.songs.findFirst({ where: eq(songs.videoId, 'shared') })).toBeDefined();
		expect(deleted).toEqual([]);
	});

	it('signs the deleted user out', async () => {
		await seedUser('u1');
		const { sessionId } = await login(db, kv, {
			username: 'user-u1',
			password: 'correct-password'
		});
		const { storage } = fakeStorage();

		await deleteUser(db, kv, storage, { actorId: 'admin', targetUserId: 'u1' });

		await expect(resolveSession(db, kv, sessionId)).rejects.toThrow(AuthError);
	});

	it('refuses to delete the last admin', async () => {
		const { storage } = fakeStorage();

		await expect(
			deleteUser(db, kv, storage, { actorId: 'someone-else', targetUserId: 'admin' })
		).rejects.toThrow(AuthError);
	});

	// The audit log has no retention policy by design, so it outlives the
	// account; pointing userId at a row that no longer exists would leave a
	// dangling reference, which is why the username is carried in detail.
	it('records the deletion under the actor, not the deleted user', async () => {
		await seedUser('u1');
		const { storage } = fakeStorage();

		await deleteUser(db, kv, storage, { actorId: 'admin', targetUserId: 'u1' });

		const entries = await db.query.auditLog.findMany();
		const entry = entries.find((e) => e.eventType === 'manual_delete');
		expect(entry?.userId).toBeNull();
		expect(entry?.actorId).toBe('admin');
		expect(JSON.parse(entry!.detail!)).toMatchObject({ username: 'user-u1' });
	});
});
