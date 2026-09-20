import { describe, it, expect } from 'vitest';
import { applyImportEvent, type ImportJobState } from './import-job-state';

function makeJob(overrides: Partial<ImportJobState> = {}): ImportJobState {
	return {
		jobId: 'job-1',
		sourceUrl: 'https://example.com/playlist',
		status: 'pending',
		totalCount: null,
		completedCount: 0,
		knownCount: 0,
		failedCount: 0,
		failures: [],
		previewEntries: null,
		fatalError: null,
		probing: null,
		...overrides
	};
}

describe('applyImportEvent', () => {
	it('start sets status to running and records totalCount', () => {
		const job = makeJob();
		const next = applyImportEvent(job, { type: 'start', totalCount: 5 });
		expect(next.status).toBe('running');
		expect(next.totalCount).toBe(5);
	});

	it('preview stores the entries without changing status', () => {
		const job = makeJob();
		const entries = [{ videoId: 'a', title: 'Song A' }];
		const next = applyImportEvent(job, { type: 'preview', entries });
		expect(next.status).toBe('pending');
		expect(next.previewEntries).toEqual(entries);
	});

	it('probing_progress records checked/total', () => {
		const job = makeJob();
		const next = applyImportEvent(job, { type: 'probing_progress', checked: 3, total: 10 });
		expect(next.probing).toEqual({ checked: 3, total: 10 });
	});

	it('probing_progress overwrites an earlier probing value rather than accumulating', () => {
		const job = makeJob({ probing: { checked: 2, total: 10 } });
		const next = applyImportEvent(job, { type: 'probing_progress', checked: 3, total: 10 });
		expect(next.probing).toEqual({ checked: 3, total: 10 });
	});

	it('preview clears probing back to null', () => {
		const job = makeJob({ probing: { checked: 10, total: 10 } });
		const next = applyImportEvent(job, { type: 'preview', entries: [] });
		expect(next.probing).toBeNull();
	});

	it('song_success increments completedCount by exactly one', () => {
		const job = makeJob({ completedCount: 2 });
		const next = applyImportEvent(job, {
			type: 'song_success',
			song: {
				videoId: 'a',
				sourcePlatform: 'youtube',
				sourceUrl: 'https://x',
				title: 'Song A',
				audioKey: 'audio/a.webm',
				codec: 'opus',
				container: 'webm',
				fileSizeBytes: 100
			}
		});
		expect(next.completedCount).toBe(3);
	});

	it('song_success does not touch failedCount or failures', () => {
		const job = makeJob({ failedCount: 1, failures: [{ videoId: 'z', reason: 'x' }] });
		const next = applyImportEvent(job, {
			type: 'song_success',
			song: {
				videoId: 'a',
				sourcePlatform: 'youtube',
				sourceUrl: 'https://x',
				title: 'Song A',
				audioKey: 'audio/a.webm',
				codec: 'opus',
				container: 'webm',
				fileSizeBytes: 100
			}
		});
		expect(next.failedCount).toBe(1);
		expect(next.failures).toEqual([{ videoId: 'z', reason: 'x' }]);
	});

	it('song_known increments knownCount, not completedCount', () => {
		const job = makeJob({ knownCount: 2 });
		const next = applyImportEvent(job, { type: 'song_known', videoId: 'a' });
		expect(next.knownCount).toBe(3);
		expect(next.completedCount).toBe(0);
	});

	it('song_known does not touch failedCount or failures', () => {
		const job = makeJob({ failedCount: 1, failures: [{ videoId: 'z', reason: 'x' }] });
		const next = applyImportEvent(job, { type: 'song_known', videoId: 'a' });
		expect(next.failedCount).toBe(1);
		expect(next.failures).toEqual([{ videoId: 'z', reason: 'x' }]);
	});

	it('song_failed increments failedCount and appends to failures', () => {
		const job = makeJob({ failures: [{ videoId: 'z', reason: 'old' }] });
		const next = applyImportEvent(job, {
			type: 'song_failed',
			failure: { videoId: 'a', reason: 'network error' }
		});
		expect(next.failedCount).toBe(1);
		expect(next.failures).toEqual([
			{ videoId: 'z', reason: 'old' },
			{ videoId: 'a', reason: 'network error' }
		]);
	});

	it('song_failed does not mutate the original failures array', () => {
		const originalFailures = [{ videoId: 'z', reason: 'old' }];
		const job = makeJob({ failures: originalFailures });
		applyImportEvent(job, { type: 'song_failed', failure: { videoId: 'a', reason: 'x' } });
		expect(originalFailures).toEqual([{ videoId: 'z', reason: 'old' }]);
	});

	it('complete marks completed when there are zero failures', () => {
		const job = makeJob({ completedCount: 3, failedCount: 0 });
		const next = applyImportEvent(job, { type: 'complete' });
		expect(next.status).toBe('completed');
	});

	it('complete marks completed when some songs succeeded despite some failures', () => {
		const job = makeJob({ completedCount: 2, failedCount: 1 });
		const next = applyImportEvent(job, { type: 'complete' });
		expect(next.status).toBe('completed');
	});

	it('complete marks failed only when every song failed and none succeeded', () => {
		const job = makeJob({ completedCount: 0, failedCount: 3 });
		const next = applyImportEvent(job, { type: 'complete' });
		expect(next.status).toBe('failed');
	});

	it('complete marks completed when songs were already known despite some failures', () => {
		const job = makeJob({ completedCount: 0, knownCount: 2, failedCount: 1 });
		const next = applyImportEvent(job, { type: 'complete' });
		expect(next.status).toBe('completed');
	});

	it('complete marks completed when there were zero songs at all (0/0)', () => {
		const job = makeJob({ completedCount: 0, failedCount: 0 });
		const next = applyImportEvent(job, { type: 'complete' });
		expect(next.status).toBe('completed');
	});

	it('fatal_error marks the job failed and records the reason', () => {
		const job = makeJob({ status: 'running' });
		const next = applyImportEvent(job, { type: 'fatal_error', reason: 'yt-dlp extraction failed' });
		expect(next.status).toBe('failed');
		expect(next.fatalError).toBe('yt-dlp extraction failed');
	});

	it('cancelled marks the job cancelled regardless of its prior status', () => {
		const job = makeJob({ status: 'failed', fatalError: 'yt-dlp extraction failed' });
		const next = applyImportEvent(job, { type: 'cancelled' });
		expect(next.status).toBe('cancelled');
	});

	it('does not mutate the input job object', () => {
		const job = makeJob({ completedCount: 1 });
		applyImportEvent(job, {
			type: 'song_success',
			song: {
				videoId: 'a',
				sourcePlatform: 'youtube',
				sourceUrl: 'https://x',
				title: 'Song A',
				audioKey: 'audio/a.webm',
				codec: 'opus',
				container: 'webm',
				fileSizeBytes: 100
			}
		});
		expect(job.completedCount).toBe(1);
	});
});
