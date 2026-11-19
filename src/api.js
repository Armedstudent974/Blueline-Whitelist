import { dapi, hasPerm, PERM, displayName, avatarUrl, DENY_REASONS } from './discord.js';
import { getConfig, saveConfig, listTypes, getType, addLog, now, parse } from './db.js';
import { decide, resetUser, postPanel, canApprove, canReset, submissionEmbeds, backfillReview, submitCompletedSessions } from './flow.js';

const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const err = (msg, status = 400) => json({ error: msg }, status);

function cookies(req) {
  const out = {};
  (req.headers.get('Cookie') || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function randHex(n = 32) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function inviteUrl(env) {
  return `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_CLIENT_ID}&scope=bot%20applications.commands&permissions=268520448`;
}

// ---------------- OAuth ----------------
export async function handleAuth(req, env, url) {
  if (url.pathname === '/login') {
    const state = randHex(16);
    const next = url.searchParams.get('next') || '/dashboard';
    const auth = new URL('https://discord.com/oauth2/authorize');
    auth.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', 'identify guilds');
    auth.searchParams.set('redirect_uri', `${url.origin}/callback`);
    auth.searchParams.set('state', state);
    auth.searchParams.set('prompt', 'none');
    return new Response(null, {
      status: 302,
      headers: [
        ['Location', auth.toString()],
        ['Set-Cookie', `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`],
        ['Set-Cookie', `oauth_next=${encodeURIComponent(next.startsWith('/') ? next : '/dashboard')}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`],
      ],
    });
  }
  if (url.pathname === '/callback') {
    const c = cookies(req);
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.get('state') !== c.oauth_state) return new Response('Login failed (state mismatch). Please try again.', { status: 400 });
    const tok = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${url.origin}/callback`,
      }),
    });
    if (!tok.ok) return new Response('Login failed: ' + (await tok.text()), { status: 400 });
    const t = await tok.json();
    const me = await (await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    const sid = randHex(32);
    await env.DB.prepare('INSERT INTO web_sessions (token, user_id, username, avatar, access_token, expires_at) VALUES (?,?,?,?,?,?)')
      .bind(sid, me.id, displayName(me), avatarUrl(me), t.access_token, now() + 7 * 86400 * 1000).run();
    return new Response(null, {
      status: 302,
      headers: [
        ['Location', c.oauth_next || '/dashboard'],
        ['Set-Cookie', `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 86400}`],
        ['Set-Cookie', 'oauth_state=; Path=/; Max-Age=0'],
      ],
    });
  }
  if (url.pathname === '/logout') {
    const c = cookies(req);
    if (c.sid) await env.DB.prepare('DELETE FROM web_sessions WHERE token=?').bind(c.sid).run();
    return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': 'sid=; Path=/; Max-Age=0' } });
  }
  return null;
}

export async function getSession(req, env) {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const s = await env.DB.prepare('SELECT * FROM web_sessions WHERE token=? AND expires_at > ?').bind(sid, now()).first();
  return s || null;
}

async function userGuilds(env, sess, force = false) {
  if (!force && sess.guilds_cache && now() - sess.guilds_cached_at < 60000) return parse(sess.guilds_cache, []);
  const r = await fetch('https://discord.com/api/v10/users/@me/guilds', { headers: { Authorization: `Bearer ${sess.access_token}` } });
  if (r.status === 401) throw Object.assign(new Error('Session expired'), { status: 401 });
  if (!r.ok) return parse(sess.guilds_cache, []);
  const g = await r.json();
  await env.DB.prepare('UPDATE web_sessions SET guilds_cache=?, guilds_cached_at=? WHERE token=?').bind(JSON.stringify(g), now(), sess.token).run();
  return g;
}

// Work out what the logged in user can do in a guild
async function access(env, sess, guildId) {
  const guilds = await userGuilds(env, sess);
  const ug = guilds.find((g) => g.id === guildId);
  if (!ug) return null;
  const bot = await env.DB.prepare('SELECT * FROM guilds WHERE id=? AND active=1').bind(guildId).first();
  if (!bot) return null;
  const cfg = await getConfig(env, guildId);
  const admin = ug.owner || hasPerm(ug.permissions, PERM.ADMIN);
  const manage = admin || hasPerm(ug.permissions, PERM.MANAGE_GUILD);
  let roles = [];
  try { roles = (await dapi(env, 'GET', `/guilds/${guildId}/members/${sess.user_id}`)).roles; } catch {}
  const adminPerm = admin ? String(PERM.ADMIN) : '0';
  return {
    guild: bot, cfg, manage,
    approve: canApprove(cfg, roles, adminPerm),
    reset: canReset(cfg, roles, adminPerm),
    view: manage || canApprove(cfg, roles, adminPerm) || canReset(cfg, roles, adminPerm),
  };
}

// ---------------- API ----------------
export async function handleApi(req, env, url) {
  const sess = await getSession(req, env);
  if (!sess) return err('Not logged in', 401);
  const p = url.pathname.replace(/^\/api/, '').split('/').filter(Boolean);
  const method = req.method;
  const actor = { id: sess.user_id, name: sess.username };
  const body = method === 'GET' ? {} : await req.json().catch(() => ({}));

  try {
    if (p[0] === 'me') return json({ id: sess.user_id, username: sess.username, avatar: sess.avatar, invite: inviteUrl(env), denyReasons: DENY_REASONS });

    if (p[0] === 'guilds' && p.length === 1) {
      const guilds = await userGuilds(env, sess, url.searchParams.has('refresh'));
      const { results: botGuilds } = await env.DB.prepare('SELECT * FROM guilds WHERE active=1').all();
      const botSet = new Map(botGuilds.map((g) => [g.id, g]));
      const connected = [];
      const addable = [];
      for (const g of guilds) {
        const manage = g.owner || hasPerm(g.permissions, PERM.ADMIN) || hasPerm(g.permissions, PERM.MANAGE_GUILD);
        if (botSet.has(g.id)) connected.push({ id: g.id, name: g.name, icon: g.icon, manage });
        else if (manage) addable.push({ id: g.id, name: g.name, icon: g.icon });
      }
      return json({ connected, addable, invite: inviteUrl(env) });
    }

    if (p[0] !== 'guilds') return err('Not found', 404);
    const gid = p[1];
    const a = await access(env, sess, gid);
    if (!a || !a.view) return err('You do not have access to this server', 403);
    const section = p[2];

    if (!section && method === 'GET') {
      const counts = {};
      const { results } = await env.DB.prepare('SELECT status, count(*) c FROM applications WHERE guild_id=? GROUP BY status').bind(gid).all();
      results.forEach((r) => (counts[r.status] = r.c));
      const inProgress = await env.DB.prepare('SELECT count(*) c FROM sessions WHERE guild_id=?').bind(gid).first();
      let roles = [], channels = [];
      try { roles = (await dapi(env, 'GET', `/guilds/${gid}/roles`)).filter((r) => r.name !== '@everyone').sort((x, y) => y.position - x.position).map((r) => ({ id: r.id, name: r.name, color: r.color })); } catch {}
      if (a.manage) {
        try { channels = (await dapi(env, 'GET', `/guilds/${gid}/channels`)).filter((c) => c.type === 0 || c.type === 5).sort((x, y) => x.position - y.position).map((c) => ({ id: c.id, name: c.name })); } catch {}
      }
      return json({
        guild: a.guild,
        perms: { manage: a.manage, approve: a.approve, reset: a.reset },
        config: a.manage ? { ...a.cfg, webhook_url: a.cfg.webhook_url } : null,
        defaultWebhook: !!env.DEFAULT_WEBHOOK_URL,
        counts: { submitted: counts.submitted || 0, approved: counts.approved || 0, denied: counts.denied || 0, in_progress: inProgress?.c || 0 },
        roles, channels,
        types: await listTypes(env, gid),
        panels: (await env.DB.prepare('SELECT * FROM panels WHERE guild_id=? ORDER BY id').bind(gid).all()).results.map((x) => ({ ...x, app_type_ids: parse(x.app_type_ids, []) })),
      });
    }

    // ---- config ----
    if (section === 'config' && method === 'PUT') {
      if (!a.manage) return err('Manage Server permission required', 403);
      if (body.webhook_url && !/^https:\/\/(ptb\.|canary\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+/.test(body.webhook_url)) return err('Invalid Discord webhook URL');
      await saveConfig(env, gid, {
        approver_roles: (body.approver_roles || []).filter((x) => /^\d+$/.test(x)),
        staff_roles: (body.staff_roles || []).filter((x) => /^\d+$/.test(x)),
        webhook_url: body.webhook_url || '',
        review_channel_id: body.review_channel_id || '',
        cooldown_hours: body.cooldown_hours ?? 48,
      });
      await addLog(env, { guild_id: gid, action: 'config', actor_id: actor.id, actor_name: actor.name, detail: 'Updated settings via dashboard' });
      const posted = await backfillReview(env, gid);
      return json({ ok: true, posted });
    }

    // ---- application types ----
    if (section === 'types') {
      if (!a.manage) return err('Manage Server permission required', 403);
      const clean = (b) => ({
        name: String(b.name || '').trim().slice(0, 80),
        description: String(b.description || '').slice(0, 1500),
        questions: (Array.isArray(b.questions) ? b.questions : []).map((q) => String(q).trim().slice(0, 1000)).filter(Boolean).slice(0, 50),
        enabled: b.enabled ? 1 : 0,
        accept_role_id: /^\d+$/.test(b.accept_role_id || '') ? b.accept_role_id : null,
        remove_role_id: /^\d+$/.test(b.remove_role_id || '') ? b.remove_role_id : null,
        button_style: [1, 2, 3, 4].includes(+b.button_style) ? +b.button_style : 1,
      });
      if (method === 'POST') {
        const t = clean(body);
        if (!t.name) return err('Name is required');
        const r = await env.DB.prepare('INSERT INTO app_types (guild_id, name, description, questions, enabled, accept_role_id, remove_role_id, button_style, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(gid, t.name, t.description, JSON.stringify(t.questions), t.enabled, t.accept_role_id, t.remove_role_id, t.button_style, now()).run();
        await addLog(env, { guild_id: gid, action: 'config', actor_id: actor.id, actor_name: actor.name, detail: `Created application "${t.name}"` });
        return json({ ok: true, id: r.meta.last_row_id });
      }
      const tid = Number(p[3]);
      const existing = await getType(env, tid);
      if (!existing || existing.guild_id !== gid) return err('Not found', 404);
      if (method === 'PUT') {
        const t = clean(body);
        if (!t.name) return err('Name is required');
        await env.DB.prepare('UPDATE app_types SET name=?, description=?, questions=?, enabled=?, accept_role_id=?, remove_role_id=?, button_style=? WHERE id=?')
          .bind(t.name, t.description, JSON.stringify(t.questions), t.enabled, t.accept_role_id, t.remove_role_id, t.button_style, tid).run();
        await addLog(env, { guild_id: gid, action: 'config', actor_id: actor.id, actor_name: actor.name, detail: `Updated application "${t.name}"` });
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await env.DB.prepare('DELETE FROM app_types WHERE id=?').bind(tid).run();
        await env.DB.prepare('DELETE FROM sessions WHERE app_type_id=?').bind(tid).run();
        await addLog(env, { guild_id: gid, action: 'config', actor_id: actor.id, actor_name: actor.name, detail: `Deleted application "${existing.name}"` });
        return json({ ok: true });
      }
    }

    // ---- panels ----
    if (section === 'panels') {
      if (!a.manage) return err('Manage Server permission required', 403);
      const clean = (b) => ({
        channel_id: /^\d+$/.test(b.channel_id || '') ? b.channel_id : null,
        title: String(b.title || 'Applications').slice(0, 256),
        description: String(b.description || '').slice(0, 4000),
        color: /^#?[0-9a-f]{6}$/i.test(b.color || '') ? (b.color.startsWith('#') ? b.color : '#' + b.color) : '#5865F2',
        image_url: /^https:\/\//.test(b.image_url || '') ? b.image_url : null,
        app_type_ids: (b.app_type_ids || []).map(Number).filter(Boolean),
      });
      if (method === 'POST' && !p[3]) {
        const c = clean(body);
        const r = await env.DB.prepare('INSERT INTO panels (guild_id, channel_id, title, description, color, image_url, app_type_ids, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .bind(gid, c.channel_id, c.title, c.description, c.color, c.image_url, JSON.stringify(c.app_type_ids), now()).run();
        return json({ ok: true, id: r.meta.last_row_id });
      }
      const pid = Number(p[3]);
      const panel = await env.DB.prepare('SELECT * FROM panels WHERE id=? AND guild_id=?').bind(pid, gid).first();
      if (!panel) return err('Not found', 404);
      if (method === 'PUT') {
        const c = clean(body);
        const moved = c.channel_id !== panel.channel_id;
        await env.DB.prepare('UPDATE panels SET channel_id=?, title=?, description=?, color=?, image_url=?, app_type_ids=?, message_id=? WHERE id=?')
          .bind(c.channel_id, c.title, c.description, c.color, c.image_url, JSON.stringify(c.app_type_ids), moved ? null : panel.message_id, pid).run();
        return json({ ok: true });
      }
      if (method === 'POST' && p[4] === 'post') {
        if (!panel.channel_id) return err('Choose a channel for the panel first');
        try {
          const mid = await postPanel(env, panel);
          await addLog(env, { guild_id: gid, action: 'config', actor_id: actor.id, actor_name: actor.name, detail: `Posted panel "${panel.title}"` });
          return json({ ok: true, message_id: mid });
        } catch (e) {
          return err('Discord refused: ' + e.message.slice(0, 200) + ' — check the bot can view & send messages in that channel.');
        }
      }
      if (method === 'DELETE') {
        if (panel.message_id && panel.channel_id) { try { await dapi(env, 'DELETE', `/channels/${panel.channel_id}/messages/${panel.message_id}`); } catch {} }
        await env.DB.prepare('DELETE FROM panels WHERE id=?').bind(pid).run();
        return json({ ok: true });
      }
    }

    // ---- applications ----
    if (section === 'applications') {
      if (method === 'GET' && !p[3]) {
        const status = url.searchParams.get('status') || 'submitted';
        const q = `%${url.searchParams.get('q') || ''}%`;
        const { results } = await env.DB.prepare(
          `SELECT * FROM applications WHERE guild_id=? AND status=? AND (username LIKE ? OR user_id LIKE ? OR app_name LIKE ?) ORDER BY created_at DESC LIMIT 200`
        ).bind(gid, status, q, q, q).all();
        return json({ applications: results.map((r) => ({ ...r, answers: parse(r.answers, []) })) });
      }
      const appId = Number(p[3]);
      const app = await env.DB.prepare('SELECT * FROM applications WHERE id=? AND guild_id=?').bind(appId, gid).first();
      if (!app) return err('Not found', 404);
      if (method === 'POST' && p[4] === 'decision') {
        if (!a.approve) return err('You need an approver role to approve or deny applications', 403);
        const r = await decide(env, appId, body.decision, body.reason, actor);
        return r.ok ? json({ ok: true }) : err(r.error);
      }
    }

    // ---- submit fully-answered questionnaires that are stuck in DMs ----
    if (section === 'sessions' && p[3] === 'submit' && method === 'POST') {
      if (!a.manage) return err('Manage Server permission required', 403);
      const done = await submitCompletedSessions(env, gid);
      return json({ ok: true, submitted: done });
    }

    // ---- reset cooldown ----
    if (section === 'reset' && method === 'POST') {
      if (!a.reset) return err('You need the staff role to reset application status', 403);
      if (!/^\d+$/.test(body.user_id || '')) return err('Invalid user ID');
      const r = await resetUser(env, gid, body.user_id, actor);
      return json({ ok: true, changed: r.changed });
    }

    // ---- logs ----
    if (section === 'logs' && method === 'GET') {
      const action = url.searchParams.get('action');
      const { results } = action
        ? await env.DB.prepare('SELECT * FROM logs WHERE guild_id=? AND action=? ORDER BY created_at DESC LIMIT 300').bind(gid, action).all()
        : await env.DB.prepare('SELECT * FROM logs WHERE guild_id=? ORDER BY created_at DESC LIMIT 300').bind(gid).all();
      return json({ logs: results });
    }

    // ---- cooldown lookup ----
    if (section === 'cooldowns' && method === 'GET') {
      const cfg = a.cfg;
      const since = now() - (cfg.cooldown_hours || 48) * 3600 * 1000;
      const { results } = await env.DB.prepare(
        `SELECT user_id, username, avatar_url, app_name, max(created_at) last FROM applications WHERE guild_id=? AND cooldown_reset=0 AND (created_at > ? OR status='submitted') GROUP BY user_id, app_type_id ORDER BY last DESC LIMIT 200`
      ).bind(gid, since).all();
      return json({ hours: cfg.cooldown_hours, users: results });
    }

    return err('Not found', 404);
  } catch (e) {
    if (e.status === 401) return err('Session expired, please log in again', 401);
    console.log('api error', e.stack);
    return err('Server error: ' + e.message, 500);
  }
}
