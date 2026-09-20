/**
 * No server load, deliberately.
 *
 * Everything this page needs beyond the session is fetched from
 * /api/account-usage on the client, so a client-side navigation here works
 * with no connection: skip silence, clearing local data and the cache
 * figures are all device-local, and only the cloud totals degrade.
 *
 * The (app) layout's own load still enforces the session; this page adds
 * nothing that would need the server before it can render.
 */
export const ssr = true;
