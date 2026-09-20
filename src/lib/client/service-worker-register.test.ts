import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerServiceWorker } from './service-worker-register';

beforeEach(() => {
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('registerServiceWorker', () => {
	it('does nothing when serviceWorker is not supported', () => {
		vi.stubGlobal('navigator', {});
		expect(() => registerServiceWorker()).not.toThrow();
	});

	it('registers the service worker module at the expected path', () => {
		const register = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { serviceWorker: { register } });

		registerServiceWorker();

		expect(register).toHaveBeenCalledWith('/service-worker.js', { type: 'module' });
	});

	it('logs but does not throw when registration rejects', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const register = vi.fn().mockRejectedValue(new Error('registration failed'));
		vi.stubGlobal('navigator', { serviceWorker: { register } });

		expect(() => registerServiceWorker()).not.toThrow();
		// registerServiceWorker itself is synchronous (fire-and-forget) - wait
		// a tick for the rejected promise's .catch to actually run.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(consoleError).toHaveBeenCalledWith(
			'Service worker registration failed',
			expect.any(Error)
		);
		consoleError.mockRestore();
	});
});
