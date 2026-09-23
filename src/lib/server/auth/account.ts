import {
	and,
	count,
	countDistinct,
	eq,
	exists,
	inArray,
	ne,
	notExists,
	notInArray,
	sql,
	type SQL
} from 'drizzle-orm';
import type { Db } from '../db';
import { playlists, playlistSongs, songs, userSongs, users } from '../db/schema';
import { hashPassword, verifyPassword } from './password';
import { AuthError, logoutAllSessions } from './service';
import { recordAuditEvent } from '../audit/log';
import type { ObjectStorage } from '../storage/s3';

/**
 * Operations on an account that already exists — changing its password,
 * suspending it, deleting it — as opposed to service.ts, which is about
 * getting into one (register/login/session). Split out because these are
 * reachable two ways, by the account's owner and by an admin acting on
 * someone else, and the rules differ between them: an admin resetting a
 * password doesn't know the old one, an owner changing theirs must prove
 * it.
 */

async function getUserOrThrow(db: Db, userId: string) {
	const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
	if (!user) {
		throw new AuthError('User not found', 'user_not_found');
	}
	return user;
}

/**
 * Every password write goes through here so that none of them can forget
 * to invalidate the existing sessions. A changed password that leaves old
 * sessions alive doesn't lock anyone out — which is the entire reason the
 * password was being changed in most cases.
 */
async function setPassword(
	db: Db,
	kv: KVNamespace,
	userId: string,
	newPassword: string
): Promise<void> {
	const passwordHash = await hashPassword(newPassword);
	await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
	await logoutAllSessions(kv, userId);
}

export interface ChangeOwnPasswordInput {
	userId: string;
	currentPassword: string;
	newPassword: string;
	ipAddress?: string;
}

/**
 * The account owner changing their own password. Requires the current one:
 * a logged-in session left open on a shared machine shouldn't be enough to
 * take the account over permanently.
 */
export async function changeOwnPassword(
	db: Db,
	kv: KVNamespace,
	input: ChangeOwnPasswordInput
): Promise<void> {
	const user = await getUserOrThrow(db, input.userId);

	if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
		await recordAuditEvent(db, {
			userId: user.id,
			actorId: user.id,
			eventType: 'login_failed',
			targetType: 'user',
			targetId: user.id,
			detail: { reason: 'wrong_current_password_on_change' },
			ipAddress: input.ipAddress
		});
		throw new AuthError('Current password is incorrect', 'invalid_credentials');
	}

	await setPassword(db, kv, user.id, input.newPassword);
	await recordAuditEvent(db, {
		userId: user.id,
		actorId: user.id,
		eventType: 'password_change',
		targetType: 'user',
		targetId: user.id,
		detail: { self: true },
		ipAddress: input.ipAddress
	});
}

export interface AdminResetPasswordInput {
	actorId: string;
	targetUserId: string;
	newPassword: string;
	ipAddress?: string;
}

/** An admin setting someone else's password, e.g. after they lose it. */
export async function adminResetPassword(
	db: Db,
	kv: KVNamespace,
	input: AdminResetPasswordInput
): Promise<void> {
	const user = await getUserOrThrow(db, input.targetUserId);

	await setPassword(db, kv, user.id, input.newPassword);
	await recordAuditEvent(db, {
		userId: user.id,
		actorId: input.actorId,
		eventType: 'password_change',
		targetType: 'user',
		targetId: user.id,
		detail: { self: false, username: user.username },
		ipAddress: input.ipAddress
	});
}

export interface ForceLogoutInput {
	actorId: string;
	targetUserId: string;
	ipAddress?: string;
}

/** Ends every session a user holds without changing their password. */
export async function forceLogout(db: Db, kv: KVNamespace, input: ForceLogoutInput): Promise<void> {
	const user = await getUserOrThrow(db, input.targetUserId);

	await logoutAllSessions(kv, user.id);
	await recordAuditEvent(db, {
		userId: user.id,
		actorId: input.actorId,
		eventType: 'force_logout',
		targetType: 'user',
		targetId: user.id,
		detail: { username: user.username, self: input.actorId === user.id },
		ipAddress: input.ipAddress
	});
}

/**
 * How many admins the instance would have left if `excludingUserId` stopped
 * being one. Used to refuse the last one: an instance with no admin has no
 * way back short of editing the database by hand.
 */
async function remainingAdminCount(db: Db, excludingUserId: string): Promise<number> {
	const [{ n }] = await db
		.select({ n: count() })
		.from(users)
		.where(
			and(
				eq(users.isAdmin, true),
				// A disabled admin cannot log in, so it cannot be the one that
				// keeps the instance administrable — counting it would allow
				// disabling the last admin who actually still has access.
				eq(users.disabled, false),
				ne(users.id, excludingUserId)
			)
		);
	return n;
}

export interface SetAdminInput {
	actorId: string;
	targetUserId: string;
	isAdmin: boolean;
	ipAddress?: string;
}

export async function setUserAdmin(db: Db, input: SetAdminInput): Promise<void> {
	const user = await getUserOrThrow(db, input.targetUserId);

	if (!input.isAdmin && (await remainingAdminCount(db, user.id)) === 0) {
		throw new AuthError('Cannot remove the last admin', 'last_admin');
	}

	await db.update(users).set({ isAdmin: input.isAdmin }).where(eq(users.id, user.id));
	await recordAuditEvent(db, {
		userId: user.id,
		actorId: input.actorId,
		eventType: 'quota_adjusted',
		targetType: 'user',
		targetId: user.id,
		detail: { username: user.username, isAdmin: input.isAdmin, change: 'admin_role' },
		ipAddress: input.ipAddress
	});
}

export interface SetDisabledInput {
	actorId: string;
	targetUserId: string;
	disabled: boolean;
	ipAddress?: string;
}

export async function setUserDisabled(
	db: Db,
	kv: KVNamespace,
	input: SetDisabledInput
): Promise<void> {
	const user = await getUserOrThrow(db, input.targetUserId);

	if (input.disabled && input.actorId === user.id) {
		throw new AuthError('You cannot disable your own account', 'cannot_target_self');
	}
	// Same reasoning as setUserAdmin: an instance whose only admin is
	// locked out has no way back in.
	if (input.disabled && user.isAdmin && (await remainingAdminCount(db, user.id)) === 0) {
		throw new AuthError('Cannot disable the last admin', 'last_admin');
	}

	await db.update(users).set({ disabled: input.disabled }).where(eq(users.id, user.id));
	if (input.disabled) {
		// resolveSession would reject them anyway, but dropping the sessions
		// now means the effect doesn't depend on that check being reached.
		await logoutAllSessions(kv, user.id);
	}

	await recordAuditEvent(db, {
		userId: user.id,
		actorId: input.actorId,
		eventType: input.disabled ? 'force_logout' : 'quota_adjusted',
		targetType: 'user',
		targetId: user.id,
		detail: { username: user.username, disabled: input.disabled, change: 'account_status' },
		ipAddress: input.ipAddress
	});
}

export interface DeleteUserInput {
	actorId: string;
	targetUserId: string;
	ipAddress?: string;
}

export interface DeleteUserResult {
	username: string;
	songsConsidered: number;
}

/**
 * Deletes an account and everything that belongs to it.
 *
 * `songs` rows are shared: two users who imported the same video reference
 * one row. So a departing user takes the songs only they had and leaves
 * everyone else's alone — the same rule evictSongForUser applies to one
 * song, applied here to the whole library at once.
 *
 * Set-based rather than song by song. Handing each song to
 * evictSongForUser cost a handful of queries per song plus one per
 * playlist — tens of thousands for a real library, where a Worker on a
 * self-hosted database may make 50. And since nothing wrapped them, a
 * request cut off part way left a half-deleted account behind. Here every
 * write is one batch, which lands whole or not at all.
 */
export async function deleteUser(
	db: Db,
	kv: KVNamespace,
	storage: ObjectStorage,
	input: DeleteUserInput
): Promise<DeleteUserResult> {
	const user = await getUserOrThrow(db, input.targetUserId);

	if (input.actorId !== user.id && user.isAdmin && (await remainingAdminCount(db, user.id)) === 0) {
		throw new AuthError('Cannot delete the last admin', 'last_admin');
	}

	const theirPlaylists = () =>
		db.select({ id: playlists.id }).from(playlists).where(eq(playlists.userId, user.id));
	const heldBy = (playlistCondition: SQL) =>
		db
			.select({ one: sql`1` })
			.from(playlistSongs)
			.where(and(eq(playlistSongs.videoId, songs.videoId), playlistCondition));

	const [{ songsConsidered }] = await db
		.select({ songsConsidered: countDistinct(playlistSongs.videoId) })
		.from(playlistSongs)
		.where(inArray(playlistSongs.playlistId, theirPlaylists()));

	const [, deletedSongs] = await db.batch([
		// Cleared first: default_playlist_id was added by ALTER TABLE, so its
		// `onDelete: 'set null'` is declarative only and would not fire (see
		// the column's own comment in schema.ts).
		db.update(users).set({ defaultPlaylistId: null }).where(eq(users.id, user.id)),
		// Songs in one of their playlists and nobody else's. Decided inside
		// the same batch as the deletes rather than read beforehand, so a song
		// someone else picks up in the meantime is never counted as theirs —
		// and RETURNING says exactly which rows went, which is what decides
		// the stored objects deleted below.
		db
			.delete(songs)
			.where(
				and(
					exists(heldBy(inArray(playlistSongs.playlistId, theirPlaylists()))),
					notExists(heldBy(notInArray(playlistSongs.playlistId, theirPlaylists())))
				)
			)
			.returning({ audioKey: songs.audioKey, coverKey: songs.coverKey }),
		db.delete(playlistSongs).where(inArray(playlistSongs.playlistId, theirPlaylists())),
		db.delete(playlists).where(eq(playlists.userId, user.id)),
		db.delete(userSongs).where(eq(userSongs.userId, user.id)),
		db.delete(users).where(eq(users.id, user.id))
	]);

	await logoutAllSessions(kv, user.id);

	// Written after the row is gone, and deliberately without userId: the
	// audit log outlives the account (it has no retention policy by
	// design), and pointing userId at an id that no longer exists would
	// leave a dangling reference. The username in detail is what makes the
	// entry readable afterwards.
	await recordAuditEvent(db, {
		actorId: input.actorId,
		eventType: 'manual_delete',
		targetType: 'user',
		targetId: user.id,
		detail: {
			username: user.username,
			self: input.actorId === user.id,
			songsConsidered,
			songsDeleted: deletedSongs.length
		},
		ipAddress: input.ipAddress
	});

	// After the rows, never before: a request cut off between the two
	// leaves stored objects with no row, which the admin orphan scan finds
	// and removes, rather than rows pointing at objects that are gone.
	await storage.deleteObjects(
		deletedSongs.flatMap((song) =>
			song.coverKey ? [song.audioKey, song.coverKey] : [song.audioKey]
		)
	);

	return { username: user.username, songsConsidered };
}
