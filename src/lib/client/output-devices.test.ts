import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listAudioOutputDevices } from './output-devices';

beforeEach(() => {
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('listAudioOutputDevices', () => {
	it('returns an empty list when mediaDevices is unavailable', async () => {
		vi.stubGlobal('navigator', {});
		await expect(listAudioOutputDevices()).resolves.toEqual([]);
	});

	it('filters to only audiooutput devices', async () => {
		vi.stubGlobal('navigator', {
			mediaDevices: {
				enumerateDevices: async () => [
					{ kind: 'audioinput', deviceId: 'mic1', label: 'Microphone' },
					{ kind: 'audiooutput', deviceId: 'spk1', label: 'Speakers' },
					{ kind: 'videoinput', deviceId: 'cam1', label: 'Camera' }
				]
			}
		});

		const devices = await listAudioOutputDevices();
		expect(devices).toEqual([{ deviceId: 'spk1', label: 'Speakers' }]);
	});

	it('falls back to a numbered name when the label is blank', async () => {
		vi.stubGlobal('navigator', {
			mediaDevices: {
				enumerateDevices: async () => [
					{ kind: 'audiooutput', deviceId: 'spk1', label: '' },
					{ kind: 'audiooutput', deviceId: 'spk2', label: '' }
				]
			}
		});

		const devices = await listAudioOutputDevices();
		expect(devices).toEqual([
			{ deviceId: 'spk1', label: 'Speaker 1' },
			{ deviceId: 'spk2', label: 'Speaker 2' }
		]);
	});
});
