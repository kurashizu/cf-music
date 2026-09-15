export interface AudioOutputDevice {
	deviceId: string;
	label: string;
}

/**
 * Lists available audio output devices. Device labels come back blank
 * (browser privacy restriction) unless the page already holds a granted
 * mic/camera permission from *some* origin-scoped grant — there's no
 * output-device-specific permission to request, so a labelless list
 * degrades to numbered fallback names rather than requesting an unrelated
 * mic permission just to unlock labels the user didn't ask to give up.
 */
export async function listAudioOutputDevices(): Promise<AudioOutputDevice[]> {
	if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];

	const devices = await navigator.mediaDevices.enumerateDevices();
	const outputs = devices.filter((d) => d.kind === 'audiooutput');

	return outputs.map((d, index) => ({
		deviceId: d.deviceId,
		label: d.label || `Speaker ${index + 1}`
	}));
}
