// @sveltejs/adapter-cloudflare's build step writes its generated Worker
// straight to whatever path wrangler.jsonc's `main` points at, overwriting
// anything already there — so a hand-written file at that path can't
// survive a build (see the comment this replaces in git history for the
// approach that didn't work). Instead, `main` stays at the adapter's
// default output path, and this script runs after `vite build` to append a
// named re-export of our Durable Object class(es), which Cloudflare
// requires to live in the same entry module as the binding's `class_name`.
import { appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../.svelte-kit/cloudflare/_worker.js', import.meta.url));

if (!existsSync(workerPath)) {
	throw new Error(`Expected built worker at ${workerPath} — did \`vite build\` run first?`);
}

const durableObjectExports = `
export { ImportProgressDurableObject } from "../../src/lib/server/durable-objects/import-progress.ts";
`;

appendFileSync(workerPath, durableObjectExports);
