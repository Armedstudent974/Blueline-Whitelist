import { handleInteraction } from './interactions.js';
import { handleAuth, handleApi, getSession, inviteUrl } from './api.js';
import { Gateway } from './gateway.js';
import LANDING from './landing.html';
import DASHBOARD from './dashboard.html';

export { Gateway };

const html = (s) => new Response(s, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
const gw = (env) => env.GATEWAY.get(env.GATEWAY.idFromName('main'));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/interactions' && request.method === 'POST') {
        ctx.waitUntil(gw(env).fetch('https://gw/ensure').catch(() => {}));
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
        const r = await gw(env).fetch('https://gw/ensure');
        const j = await r.json();
        return Response.json({ gateway: j.connected && j.ready ? 'online' : 'connecting', bot: j.bot?.username || null, error: j.fatal ? `fatal close ${j.fatal}` : null });
      }
      if (path === '/') return html(LANDING);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.log('fatal', e.stack);
      return new Response('Server error', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(gw(env).fetch('https://gw/ensure').catch((e) => console.log('ensure failed', e.message)));
    ctx.waitUntil(env.DB.prepare('DELETE FROM web_sessions WHERE expires_at < ?').bind(Date.now()).run());
    // abandon DM questionnaires idle for more than 7 days
    ctx.waitUntil(env.DB.prepare('DELETE FROM sessions WHERE started_at < ?').bind(Date.now() - 7 * 86400 * 1000).run());
  },
};
