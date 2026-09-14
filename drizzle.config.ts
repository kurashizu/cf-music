import { defineConfig } from 'drizzle-kit';

// drizzle-kit is only used to generate local SQL migration files (no connection to remote D1).
// Applying them to the actual database always goes through `wrangler d1 execute`
// (reusing wrangler's own OAuth session), so no separate Cloudflare API Token is needed.
export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './migrations',
	dialect: 'sqlite',
	verbose: true,
	strict: true
});
