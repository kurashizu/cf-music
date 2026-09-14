import type { ImportProgressMessage } from './import-progress';

/** Forwards a progress update to the given user's Import Progress DO for broadcast over WebSocket. */
export async function reportImportProgress(env: Env, userId: string, message: ImportProgressMessage): Promise<void> {
	const id = env.IMPORT_PROGRESS.idFromName(userId);
	const stub = env.IMPORT_PROGRESS.get(id);

	await stub.fetch('https://do/report', {
		method: 'POST',
		body: JSON.stringify(message)
	});
}
