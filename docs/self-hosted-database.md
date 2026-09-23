# Using a self-hosted database instead of D1

The app talks to its database only through Drizzle's SQLite query builder,
so the storage engine behind it is interchangeable. Two backends are
supported out of the box:

| Backend                                                                       | When it is used                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| Cloudflare D1                                                                 | Default. Nothing to configure beyond the `DB` binding. |
| Self-hosted [libSQL server](https://github.com/tursodatabase/libsql) (`sqld`) | Used as soon as `LIBSQL_URL` is set.                   |

Both speak the same SQLite dialect and run the same migrations, so the
schema and every query are identical either way. Switching is a
configuration change, not a code change.

## Why you might self-host

D1 bills by _rows read_, not by bytes or time. Queries that scan a table
to filter it — the library page reads roughly 10k rows per visit — are
cheap in wall-clock terms but expensive against that quota. On a server
you own, the same queries cost nothing extra.

The trade-off is latency: a D1 binding is a local call from the Worker,
while a self-hosted server is an HTTP round trip. Measured from Australia
through a Cloudflare tunnel, that is roughly 80ms per query, against
single-digit milliseconds of actual SQLite time.

## Setting it up

1. Run `sqld` on your host, listening on loopback:

   ```
   sqld --db-path /var/lib/sqld/data \
        --http-listen-addr 127.0.0.1:8080 \
        --auth-jwt-key-file /etc/sqld/jwt_public.pem
   ```

2. Expose it over HTTPS — a Cloudflare tunnel works well, and keeps the
   port off the public internet.

3. Point the Worker at it:

   ```
   # wrangler.jsonc, under "vars"
   "LIBSQL_URL": "https://db.example.com"
   ```

   ```
   printf '<token>' | npx wrangler secret put LIBSQL_AUTH_TOKEN
   ```

   Use `printf`, not `echo`: a trailing newline becomes part of the secret
   and the server will reject the token.

Once `LIBSQL_URL` is set it takes precedence, even if a `DB` binding is
still present — so you can leave D1 bound while migrating and cut over by
setting one variable.

## Authentication

`sqld` authenticates clients with an Ed25519-signed JWT. Generate a
keypair, give the server the public half, and sign a token with the
private half:

```
openssl genpkey -algorithm ed25519 -out jwt_private.pem
openssl pkey -in jwt_private.pem -pubout -out jwt_public.pem
```

The token's payload should be `{"a":"rw"}` for full read/write access.
Note that `sqld` reads an `id` claim as a _namespace name_, so a token
like `{"id":"my-worker"}` will fail with `Namespace ... doesn't exist`
rather than an auth error.

A token with `"a":"rw"` grants complete access to the whole database, so
treat it as a root credential: keep it in a secret, never a var.

## Round trips per request

Against libSQL over HTTP, every query a request makes is its own fetch,
and a Worker on the free plan may make 50 per invocation. D1 calls count
against a separate allowance of 1,000, so a request that is fine on D1 can
fail on libSQL at the 51st query.

The code here keeps every request to a handful of round trips however
large the library is: set-based statements rather than a query per item,
and `db.batch()` (`runInOneRequest`) where a write has to be many
statements. `src/lib/server/subrequest-budget.integration.test.ts` counts
the round trips of the operations that scale with library size and fails
if any of them grows — add to it when writing something that loops.

## Migrating existing data

Export from D1 and load into the new server:

```
npx wrangler d1 export cf-music --remote --output dump.sql
```

Then apply `dump.sql` to the libSQL server. Verify row counts on both
sides before removing the D1 binding.
