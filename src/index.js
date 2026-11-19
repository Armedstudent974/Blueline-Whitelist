import { handleInteraction } from './interactions.js';
import { handleAuth, handleApi, getSession, inviteUrl } from './api.js';
import { Gateway, GatewayEvents } from './gateway.js';
import { submitCompletedSessions } from './flow.js';
import LANDING from './landing.html';
import DASHBOARD from './dashboard.html';

export { Gateway, GatewayEvents };

const html = (s) => new Response(s, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/interactions' && request.method === 'POST') {
        return handleInteraction(request, env, ctx);
      }
      if (path.startsWith('/api/')) return handleApi(request, env, url);
      const auth = await handleAuth(request, env, url);
      if (auth) return auth;
      if (path === '/invite') return Response.redirect(inviteUrl(env), 302);
      if (path === '/dashboard') {
        const s = await getSession(request, env);
        if (!s) return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(path + url.search)}`, 302);
        return html(DASHBOARD);
      }
      if (path === '/status') {
        // Connection is hosted by the shared gateway in the blueline-tickets Worker.
        const row = await env.DB.prepare("SELECT v FROM kv WHERE k='gw_status'").first();
        const st = row?.v ? JSON.parse(row.v) : null;
        return Response.json({ gateway: st ? 'online' : 'connecting', bot: st?.bot || null, since: st?.at || null, host: 'blueline-tickets shared gateway', error: null });
      }
      if (path === '/') return html(LANDING);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.log('fatal', e.stack);
      return new Response('Server error', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.DB.prepare('DELETE FROM web_sessions WHERE expires_at < ?').bind(Date.now()).run());
    // one-shot admin action: submit fully-answered applications stuck in DMs (set kv 'force_submit' = guild id)
    ctx.waitUntil((async () => {
      const row = await env.DB.prepare("SELECT v FROM kv WHERE k='force_submit'").first();
      if (!row?.v) return;
      await env.DB.prepare("DELETE FROM kv WHERE k='force_submit'").run();
      const done = await submitCompletedSessions(env, row.v);
      await env.DB.prepare("INSERT INTO kv (k, v) VALUES ('force_submit_result', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(new Date().toISOString() + ' ' + JSON.stringify(done)).run();
    })().catch((e) => console.log('force submit error', e.message)));
    // abandon DM questionnaires idle for more than 7 days
    ctx.waitUntil(env.DB.prepare('DELETE FROM sessions WHERE started_at < ?').bind(Date.now() - 7 * 86400 * 1000).run());
  },
};
