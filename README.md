# KRSZ Music

A self-hosted music library that imports from YouTube and anywhere else
yt-dlp can reach, stores the audio in your own object storage, and plays it
back in the browser — online or off.

Runs on Cloudflare Workers, with the heavy lifting pushed out to GitHub
Actions so the parts that need ffmpeg and a real filesystem aren't fighting
a serverless runtime.

## What it does

**Import** — paste a video or playlist URL. The Worker dispatches a GitHub
Actions run that downloads with yt-dlp, transcodes, extracts cover art and
metadata, and uploads to your S3-compatible bucket. Progress streams back
over a WebSocket while it runs, so the page shows songs landing one at a
time rather than a spinner. Playlists are capped at 1000 entries per
import, and the UI says so when one was truncated.

**Library** — playlists, drag-to-reorder, batch select, copy and move
between playlists, search and filter by artist or duration.

**Smart playlists** — six of them, rebuilt on a schedule: Recently Played,
On Repeat, Forgotten Favorites, This Week's Vibe, Deep Cuts, and Sound
Clusters. The last is built from audio embeddings (gemini-embedding-2)
rather than listening history, so it groups songs that actually sound
alike. One playlist per artist is generated too.

**Offline** — a service worker caches audio as you play it, with an LRU/LFU
eviction policy and a configurable size limit. Songs you download
explicitly are pinned and never evicted automatically. The library,
settings and player all work with no connection.

**Quotas and storage** — per-user storage limits, enforced at import time
by reserving space before the download starts. Optional auto-eviction drops
the least-played songs when a user runs out of room. Admin tools scan for
orphaned objects and unreferenced songs.

**Accounts** — invite-code registration, per-user quotas, password changes,
forced logout, account suspension and deletion. Every privileged action
lands in an audit log.

## Architecture

```
Browser ──► Cloudflare Worker ──► SQLite (D1, or self-hosted libSQL)
                 │                        │
                 │                        └── KV: sessions
                 │                        └── Durable Object: import progress
                 │
                 ├──► S3-compatible storage (audio, cover art)
                 └──► GitHub Actions ──► yt-dlp + ffmpeg ──► storage
```

The Worker never downloads or transcodes anything itself. It validates,
reserves quota, dispatches a workflow, and relays that workflow's progress
to the browser over a WebSocket held open by a Durable Object.

**SvelteKit 5** (runes) on the front end, **Drizzle** over SQLite,
**Tailwind 4** with shadcn-svelte components.

### Database

D1 by default. Setting `LIBSQL_URL` points an instance at a self-hosted
[libSQL server](https://github.com/tursodatabase/libsql) instead — same
schema, same migrations, same queries. See
[docs/self-hosted-database.md](docs/self-hosted-database.md) for why you
might want that (D1 bills per row read, which suits some workloads better
than others) and how to set it up.

## Getting started

Requires Node 22+, a Cloudflare account, an S3-compatible bucket (MinIO
works), and a GitHub repo to run the import workflow in.

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in the values below
npm run db:migrate:local
npm run dev
```

`.dev.vars` needs:

| Variable                                | What it's for                               |
| --------------------------------------- | ------------------------------------------- |
| `MINIO_ENDPOINT`, `MINIO_BUCKET`        | Where audio and covers live                 |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`  | Credentials for that bucket                 |
| `IMPORT_WEBHOOK_SECRET`                 | Shared HMAC secret with the import workflow |
| `EMBEDDING_WEBHOOK_SECRET`              | Same, for the embedding workflow            |
| `GITHUB_ACTIONS_TOKEN`                  | Dispatches the import workflow              |
| `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME` | Which repo to dispatch it in                |

For a real deployment, put the secrets in Wrangler rather than a file:

```bash
printf '<value>' | npx wrangler secret put IMPORT_WEBHOOK_SECRET
```

Use `printf`, not `echo` — a trailing newline becomes part of the secret
and silently breaks every HMAC comparison against it.

Then:

```bash
npm run db:migrate:remote
npm run build && npx wrangler deploy
```

Registration always needs an invite code, and invite codes come from the
admin panel — so the first admin has to be created directly in the
database. Register once with a code you insert by hand, then flip that
row's `is_admin`:

```sql
-- invite_codes.created_by is NOT NULL and references users.id, so the
-- code needs an issuer row to hang off.
INSERT INTO users (id, username, password_hash) VALUES ('bootstrap', 'bootstrap', 'x');
INSERT INTO invite_codes (code, created_by) VALUES ('BOOTSTRAP', 'bootstrap');
```

Register through the UI with that code, then promote yourself:

```sql
UPDATE users SET is_admin = 1 WHERE username = 'you';
```

Leave the `bootstrap` row in place — the invite code it issued still
points at it, so deleting it fails the foreign key. It can't be logged
into (its password hash isn't a valid one), and you can disable it from
the admin panel.

## Development

```bash
npm run dev              # dev server
npm run check            # typecheck (this, not raw tsc)
npm test                 # unit tests
npm run test:integration # integration tests, in real workerd via Miniflare
npm run test:e2e         # Playwright, against system Chrome
npm run test:all         # everything, including mutation testing
```

Integration tests run inside workerd with real D1/KV/Durable Object
bindings, so the data-access layer is exercised against an actual SQLite
rather than a mock. The import script (`docker/import/import.py`) has its
own dependency-free suite that runs before its image is built.

Database changes go through Drizzle:

```bash
npx drizzle-kit generate   # after editing src/lib/server/db/schema.ts
npm run db:migrate:local
```
