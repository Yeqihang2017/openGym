# openGym on Cloudflare — migration preview

This directory begins the port from the Node.js/Docker API to Cloudflare Workers,
D1 and R2. It is **not yet a replacement** for a working openGym server.

## Current state

| Feature | Status |
| --- | --- |
| React/Vite shell and immutable exercise media | Wired for Workers Static Assets |
| Public `/api/config` (guest mode) | Implemented |
| D1 health check | Implemented |
| D1 relational schema | Initial migration; import not implemented |
| R2 + D1 profile-state storage | Internal module with atomic pointer updates; not yet connected to authenticated routes |
| User media upload | Not implemented; authorization and quotas still required |
| Passkeys, accounts, synced training history | Not implemented in Worker |
| AI Coach and reminders | Not implemented in Worker |

All other `/api` calls return `501` with `migration-incomplete`. Do not put this
preview at your production domain or import live records into it.

## Local development

1. Install dependencies: `npm ci --prefix frontend` and `npm ci --prefix cloudflare` from the repository root.
2. Build the web frontend: `npm run build:web --prefix cloudflare`.
3. From `cloudflare/`, run `npx wrangler d1 migrations apply opengym-cloudflare-preview --local`.
4. From `cloudflare/`, run `npm run dev`.
5. Run `npm test --prefix cloudflare` and `npm run check --prefix cloudflare` before deploying.

`wrangler.jsonc` declares D1 and R2 by name without live resource IDs. Wrangler
4.45+ can provision them when first deployed. **Do not deploy this branch until
the remaining API routes and data migration are implemented and tested.**

## Next milestones

1. Port passkey challenge management, registration, login, sessions and account administration to D1, preserving the upstream API shapes.
2. Port `GET/PUT /api/data` including `_rev`, `_wid`, conflict responses, and `sync-stamps.js` semantics with an atomic D1 conditional write.
3. Port user media with authenticated R2 access and quotas.
4. Port the provider-based AI Coach to Workers and persistent jobs; evaluate background work and reminder scheduling separately.
5. Add a read-only validation and backup/import utility for upstream `./data` JSON files, plus end-to-end regression tests, before moving any real data.
6. Enable staged deployment on `workers.dev`, followed by custom-domain cutover only after parity is verified.

## Licensing

The fork continues to follow the upstream AGPL-3.0-or-later license. Preserve
`catalogue/media/NOTICE.md` when staging exercise animations and stills.

### Why training JSON lives in R2

Cloudflare D1 limits a single row/TEXT value to 2 MB, while real upstream
openGym profile JSON can exceed that. D1 stores the revision, write id and a
pointer to an immutable R2 object. The new object is written before D1 publishes
the pointer, and D1's conditional update rejects stale writers. Historical R2
objects must be retained for a grace period so a concurrent reader holding an
older pointer can still finish; a future garbage collector can remove truly
unreferenced, sufficiently old objects.

The Worker uses the original server's 5 MiB profile-state ceiling. On Workers
Free, CPU-intensive synchronization (especially very large histories) still
needs profiling against the 10 ms CPU limit before public launch.
