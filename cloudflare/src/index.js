/* Cloudflare migration preview.
 *
 * Deliberately exposes no accounts, uploads, or state writes until auth, sync conflict
 * handling and media authorization are ported and tested. Unsupported API calls must
 * never fall through to the SPA's index.html and appear to have succeeded.
 */

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      try {
        await env.DB.prepare('SELECT 1 AS ready').first();
        return json(200, { ok: true, storage: 'd1', phase: 'preview' });
      } catch (error) {
        console.error(JSON.stringify({ event: 'health_error', message: String(error) }));
        return json(503, { ok: false, error: 'database unavailable' });
      }
    }

    if (url.pathname === '/api/config' && request.method === 'GET') {
      // The preview supports the upstream client's local-only guest mode. Its existing
      // authenticated API must not be advertised until the complete port is ready.
      return json(200, { invite_only: false, allow_guest: true });
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return json(501, {
        error: 'This endpoint is not yet available in the Cloudflare migration preview',
        code: 'migration-incomplete'
      });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    return env.ASSETS.fetch(request);
  }
};
