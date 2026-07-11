// seanhase-api — single Worker serving the admin SPA (static assets) + all API routes.
// P0 skeleton: health check + asset passthrough. Routes land in P2.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      try {
        const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM settings').first();
        return Response.json({ ok: true, settingsRows: row.n });
      } catch (e) {
        return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // Daily health check (PAT expiry, iCal feed, mail failures) — implemented in P2.
  },
};
