// Augments the generated Cloudflare.Env with bindings that only exist in the
// vitest-pool-workers test runtime (injected via miniflare.bindings in
// vitest.config.workers.ts), not in the real Worker's wrangler.jsonc.
import type { D1Migration } from 'cloudflare:test';

declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
			/** Tests always run on D1, whichever database a deployment uses. */
			DB: D1Database;
		}
	}

	interface Env {
		TEST_MIGRATIONS: D1Migration[];
		DB: D1Database;
	}
}
