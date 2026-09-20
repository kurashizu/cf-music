import { describe, it, expect } from 'vitest';
import { apiErrorMessage } from './api-error';

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 400,
		headers: { 'content-type': 'application/json' }
	});
}

describe('apiErrorMessage', () => {
	it('prefers the message the server actually sent', async () => {
		const response = jsonResponse({ message: 'Cannot remove songs from your default playlist' });
		expect(await apiErrorMessage(response, 'Failed to remove song')).toBe(
			'Cannot remove songs from your default playlist'
		);
	});

	it('falls back when the body has no message', async () => {
		expect(await apiErrorMessage(jsonResponse({}), 'Failed to remove song')).toBe(
			'Failed to remove song'
		);
	});

	it('falls back when the message is blank', async () => {
		expect(await apiErrorMessage(jsonResponse({ message: '   ' }), 'Failed')).toBe('Failed');
	});

	it('falls back when the body is not JSON', async () => {
		// A 500 from the edge, or an HTML error page — neither should surface
		// as an empty toast.
		const response = new Response('<html>502 Bad Gateway</html>', { status: 502 });
		expect(await apiErrorMessage(response, 'Failed to save')).toBe('Failed to save');
	});

	it("falls back for SvelteKit's placeholder, which says less than the caller's own text", async () => {
		// An unhandled throw yields {"message":"Internal Error"} — strictly
		// worse than "Failed to start import", which at least names the action.
		const response = jsonResponse({ message: 'Internal Error' });
		expect(await apiErrorMessage(response, 'Failed to start import')).toBe(
			'Failed to start import'
		);
	});

	it('falls back for an empty body', async () => {
		expect(await apiErrorMessage(new Response(null, { status: 500 }), 'Failed')).toBe('Failed');
	});
});
