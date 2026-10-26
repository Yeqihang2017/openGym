# openGym on Cloudflare — migration preview

This directory begins the port from the Node.js/Docker API to Cloudflare Workers,
D1 and R2. It is **not yet a replacement** for a working openGym server.

## Current state

| Feature | Status |
| --- | --- |
| React/Vite shell and immutable exercise media | Wired for Workers Static Assets |
| Public `/api/config` (guest mode and guarded initial signup) | Implemented |
| D1 health check | Implemented |
| D1 relational schema | Initial migration; import not implemented |
| R2 + D1 profile-state sync (`GET/PUT /api/data`, `/api/data/rev`) | Implemented with authenticated sessions and atomic pointer updates; needs real-device testing |
| User media upload | Not implemented; authorization and quotas still required |
| Passkey registration and login | Initial-owner-only registration and login with D1 challenges; other account features not yet ported |
| Revocable sessions | HttpOnly signed cookies and sign-out everywhere implemented |
| Invites, account recovery, adding passkeys, admin and device pairing | Not implemented; registration closes after first owner |
| AI Coach and reminders | Not implemented in Worker |

Unported `/api` routes return `501` with `migration-incomplete`. Do not put this
preview at your production domain or import live records into it. In particular,
the first owner cannot add a backup passkey or recover an account yet.

## Local development

1. Install dependencies: `npm ci --prefix frontend` and `npm ci --prefix cloudflare` from the repository root.
2. Build the web frontend: `npm run build:web --prefix cloudflare`.
3. Create an ignored `cloudflare/.dev.vars` for the **local preview only**:

   ```dotenv
   SESSION_SECRET=<random string of at least 32 characters>
   BOOTSTRAP_CODE=<random uppercase code, 24 to 40 characters>
   PUBLIC_ORIGIN=http://localhost:8787
   ```

   `SESSION_SECRET` signs login cookies. Treat both values as passwords. The
   browser's existing signup form uppercases the setup code and limits it to 40
   characters. Never commit `.dev.vars`, secrets or your live data.
4. From `cloudflare/`, run `npx wrangler d1 migrations apply opengym-cloudflare-preview --local`.
5. From `cloudflare/`, run `npm run dev`; open the local site, create the first
   owner with the setup code and a passkey. Further registrations are closed.
6. Run `npm test --prefix cloudflare` and `npm run check --prefix cloudflare`
   before pushing changes. These validate the API and dry-run the Worker bundle;
   neither command deploys it.

For an eventual real deployment, `SESSION_SECRET` and `BOOTSTRAP_CODE` must be
provisioned as Cloudflare Worker **secrets**, not plain `wrangler.jsonc` vars.
Set `PUBLIC_ORIGIN` to the final HTTPS origin and `RP_ID` to its hostname.
Passkeys are bound to this relying-party identity: changing domains afterward
may make existing passkeys unusable on the new site.

`wrangler.jsonc` declares D1 and R2 by name without live resource IDs. Wrangler
4.45+ can provision them when first deployed. **Do not deploy this branch until
the remaining API routes and data migration are implemented and tested.**

## Next milestones

1. Finish account management: owner recovery strategy, additional passkeys,
   invitations, device pairing, admin controls and anti-abuse protection.
2. Port user media with authenticated R2 access, deduplication and quotas.
3. Port the provider-based AI Coach (including OpenAI-compatible endpoints,
   such as DeepSeek) to Workers; budget for AI response time and token costs.
4. Evaluate reminders, background work and other Node-only features for
   Workers compatibility, and add real-browser/WebAuthn regression tests.
5. Add a read-only validation and backup/import utility for upstream `./data`
   JSON files before moving any real data.
6. Enable a staged `workers.dev` deployment, followed by custom-domain cutover
   only after feature parity and data recovery are verified.

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
