// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { AuthenticatedSession } from '$lib/server/auth/service';

declare global {
	// Injected by vite.config.ts's `define` at build time — see readCommitHash there.
	const __BUILD_COMMIT__: string;
	const __BUILD_TIME__: string;

	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}

		interface Locals {
			session: AuthenticatedSession | null;
		}

		// interface Error {}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
