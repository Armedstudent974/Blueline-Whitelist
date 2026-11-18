import { handleDM } from './flow.js';
import { registerCommands, COMMANDS } from './interactions.js';
import { kvGet, kvSet, now } from './db.js';

const INTENTS = (1 << 0) | (1 << 12); // GUILDS + DIRECT_MESSAGES (DM content does not need the privileged intent)
const FATAL = [4004, 4010, 4011, 4012, 4013, 4014];

export class Gateway {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.open = false;
    this.ready = false;
    this.connecting = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.hbInterval = 41250;
    this.acked = true;
    this.lastEvent = 0;
    this.lastError = null;
    this.fatal = null;
    this.botUser = null;
    state.blockConcurrencyWhile(async () => {
      const m = await state.storage.get(['seq', 'sessionId', 'resumeUrl', 'fatal']);
      this.seq = m.get('seq') ?? null;
      this.sessionId = m.get('sessionId') ?? null;
      this.resumeUrl = m.get('resumeUrl') ?? null;
      this.fatal = m.get('fatal') ?? null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/reset') {
      this.fatal = null;
      await this.state.storage.delete(['fatal', 'sessionId', 'resumeUrl', 'seq']);
      this.sessionId = null; this.resumeUrl = null; this.seq = null;
      try { this.ws?.close(1000, 'reset'); } catch {}
      this.ws = null; this.open = false;
    }
    if (url.pathname !== '/status') await this.ensure();
    return Response.json({
      connected: this.open,
      ready: this.ready,
      bot: this.botUser,
      session: !!this.sessionId,
      lastEvent: this.lastEvent,
      lastError: this.lastError,
      fatal: this.fatal,
    });
  }

  async alarm() {
    try {
      await this.ensure();
      if (this.open && this.ready) this.heartbeat();
      await this.state.storage.put('seq', this.seq);
    } catch (e) {
      this.lastError = String(e.message || e);
    } finally {
      await this.state.storage.setAlarm(Date.now() + Math.min(this.hbInterval, 40000));
    }
  }

  async ensure() {
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 5000);
    if (this.fatal) return;
    if (this.open && this.ws) return;
    if (!this.connecting) this.connecting = this.connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  async connect() {
    const resume = !!(this.sessionId && this.resumeUrl);
    const base = (resume ? this.resumeUrl : 'wss://gateway.discord.gg').replace(/^wss:/, 'https:');
    const resp = await fetch(`${base}/?v=10&encoding=json`, { headers: { Upgrade: 'websocket' } });
    const ws = resp.webSocket;
    if (!ws) {
      this.lastError = `Gateway upgrade failed: ${resp.status}`;
      throw new Error(this.lastError);
    }
    ws.accept();
    this.ws = ws;
    this.open = true;
    this.ready = false;
    this.acked = true;
    this.resuming = resume;

    // process gateway events one at a time, in order
    this.queue = Promise.resolve();
    ws.addEventListener('message', (e) => {
      this.queue = this.queue.then(() => this.onMessage(e.data)).catch((err) => (this.lastError = String(err.stack || err)));
    });
    ws.addEventListener('close', (e) => this.onClose(ws, e.code, e.reason));
    ws.addEventListener('error', () => this.onClose(ws, 1006, 'error'));
  }

  onClose(ws, code, reason) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.open = false;
    this.ready = false;
    this.lastError = `closed ${code} ${reason || ''}`;
    if (FATAL.includes(code)) {
      this.fatal = code;
      this.state.storage.put('fatal', code);
      return;
    }
    if (code === 4007 || code === 4009 || code === 1000) {
      this.sessionId = null; this.resumeUrl = null; this.seq = null;
      this.state.storage.delete(['sessionId', 'resumeUrl', 'seq']);
    }
    // reconnect soon via alarm
    this.state.storage.setAlarm(Date.now() + 2000);
  }

  send(op, d) {
    try { this.ws?.send(JSON.stringify({ op, d })); } catch (e) { this.lastError = String(e); }
  }

  heartbeat() {
    if (!this.acked) {
      // zombied connection -> reconnect & resume
      try { this.ws?.close(4000, 'zombie'); } catch {}
      this.onClose(this.ws, 4000, 'zombie');
      return;
    }
    this.acked = false;
    this.send(1, this.seq);
  }

  async onMessage(raw) {
    const p = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    if (p.s != null) this.seq = p.s;
    this.lastEvent = Date.now();
    switch (p.op) {
      case 10: {
        this.hbInterval = p.d.heartbeat_interval;
        this.acked = true;
        this.send(1, this.seq);
        if (this.resuming) {
          this.send(6, { token: this.env.DISCORD_TOKEN, session_id: this.sessionId, seq: this.seq });
        } else {
          this.send(2, {
            token: this.env.DISCORD_TOKEN,
            intents: INTENTS,
            properties: { os: 'linux', browser: 'blueline', device: 'blueline' },
            presence: { status: 'online', afk: false, since: null, activities: [{ name: 'Blueline Whitelist Applications', type: 3 }] },
          });
        }
        await this.state.storage.setAlarm(Date.now() + Math.min(this.hbInterval, 40000));
        break;
      }
      case 11: this.acked = true; break;
      case 1: this.send(1, this.seq); break;
      case 7: // reconnect requested
        try { this.ws?.close(4000, 'reconnect'); } catch {}
        this.onClose(this.ws, 4000, 'reconnect');
        break;
      case 9: // invalid session
        if (!p.d) {
          this.sessionId = null; this.resumeUrl = null; this.seq = null;
          await this.state.storage.delete(['sessionId', 'resumeUrl', 'seq']);
        }
        try { this.ws?.close(4000, 'invalid session'); } catch {}
        this.onClose(this.ws, 4000, 'invalid');
        break;
      case 0: await this.dispatch(p.t, p.d); break;
    }
  }

  async dispatch(t, d) {
    const env = this.env;
    if (t === 'READY') {
      this.ready = true;
      this.sessionId = d.session_id;
      this.resumeUrl = d.resume_gateway_url;
      this.botUser = { id: d.user.id, username: d.user.username };
      await this.state.storage.put({ sessionId: this.sessionId, resumeUrl: this.resumeUrl });
      // guilds listed in READY are the ones the bot is in; anything else is inactive
      const ids = (d.guilds || []).map((g) => g.id);
      if (ids.length) {
        await env.DB.prepare(`UPDATE guilds SET active = CASE WHEN id IN (${ids.map(() => '?').join(',')}) THEN 1 ELSE 0 END`).bind(...ids).run();
      } else {
        await env.DB.prepare('UPDATE guilds SET active=0').run();
      }
      const hash = await sha(JSON.stringify(COMMANDS));
      if ((await kvGet(env, 'cmd_hash')) !== hash) {
        try { await registerCommands(env); await kvSet(env, 'cmd_hash', hash); } catch (e) { this.lastError = 'register: ' + e.message; }
      }
      return;
    }
    if (t === 'RESUMED') { this.ready = true; return; }
    if (t === 'GUILD_CREATE' || t === 'GUILD_UPDATE') {
      await env.DB.prepare(
        `INSERT INTO guilds (id, name, icon, active, joined_at) VALUES (?,?,?,1,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon, active=1`
      ).bind(d.id, d.name, d.icon || null, now()).run();
      return;
    }
    if (t === 'GUILD_DELETE') {
      if (!d.unavailable) await env.DB.prepare('UPDATE guilds SET active=0 WHERE id=?').bind(d.id).run();
      return;
    }
    if (t === 'MESSAGE_CREATE') {
      if (d.guild_id || d.author?.bot) return;
      await handleDM(env, d);
    }
  }
}

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
