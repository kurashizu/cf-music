// Augments the generated Cloudflare.Env with bindings that only exist in the
// vitest-pool-workers test runtime (injected via miniflare.bindings in
// vitest.config.workers.ts), not in the real Worker's wrangler.jsonc.
import type { D1Migration } from 'cloudflare:test';

declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
		}
	}

	interface Env {
		TEST_MIGRATIONS: D1Migration[];
	}
}
