// The whitelist bot's Discord connection is now hosted by the shared gateway
// Durable Object in the blueline-tickets Worker (one always-on object for the
// whole account keeps it inside Cloudflare's free tier).
//
// That host connects with this bot's own token/intents (from gatewayConfig) and
// forwards events to GatewayEvents.event() below, which runs THIS Worker's code.
// Nothing here is shared with the ticket bot.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleDM } from './flow.js';
import { registerCommands, COMMANDS } from './interactions.js';
import { kvGet, kvSet, now } from './db.js';

export const INTENTS = (1 << 0) | (1 << 12); // GUILDS + DIRECT_MESSAGES (DM content does not need the privileged intent)

// Private RPC entrypoint - only reachable from Workers with a service binding
// to it (not from the internet).
export class GatewayEvents extends WorkerEntrypoint {
  async gatewayConfig() {
    return {
      token: this.env.DISCORD_TOKEN,
      intents: INTENTS,
      presence: { status: 'online', afk: false, since: null, activities: [{ name: 'Blueline Whitelist Applications', type: 3 }] },
    };
  }

  async event(t, d) {
    await handleGatewayEvent(this.env, t, d);
  }
}

export async function handleGatewayEvent(env, t, d) {
  if (t === 'READY') {
    await kvSet(env, 'gw_status', JSON.stringify({ bot: d.user?.username || null, at: Date.now() }));
    // guilds listed in READY are the ones the bot is in; anything else is inactive
    const ids = (d.guilds || []).map((g) => g.id);
    if (ids.length) {
      await env.DB.prepare(`UPDATE guilds SET active = CASE WHEN id IN (${ids.map(() => '?').join(',')}) THEN 1 ELSE 0 END`).bind(...ids).run();
    } else {
      await env.DB.prepare('UPDATE guilds SET active=0').run();
    }
    const hash = await sha(JSON.stringify(COMMANDS));
    if ((await kvGet(env, 'cmd_hash')) !== hash) {
      await registerCommands(env);
      await kvSet(env, 'cmd_hash', hash);
    }
    return;
  }
  if (t === 'RESUMED') return;
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

// Old Durable Object, kept only so existing deployments migrate cleanly.
// It no longer connects to Discord; its last alarm clears itself and it sleeps forever.
export class Gateway {
  constructor(state) { this.state = state; }
  async fetch() { return Response.json({ retired: true, note: 'Connection is hosted by the blueline-tickets gateway' }); }
  async alarm() {
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }
}

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
