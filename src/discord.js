export const API = 'https://discord.com/api/v10';

export const DENY_REASONS = [
  'Lack of detail',
  "Don't meet our minimum age requirements of 16+",
  'Not enough past roleplay experience',
];

export const PERM = { ADMIN: 0x8n, MANAGE_GUILD: 0x20n };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function dapi(env, method, path, body, opts = {}) {
  const headers = { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'User-Agent': 'BluelineWhitelist (https://dmpforge.co.uk, 1.0)' };
  let payload;
  if (opts.files?.length) {
    payload = toMultipart(body, opts.files);
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (opts.reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(opts.reason);
  for (let i = 0; i < 4; i++) {
    const r = await fetch(API + path, { method, headers, body: payload });
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await sleep(Math.min(10, j.retry_after || 1) * 1000 + 100);
      continue;
    }
    if (!r.ok) {
      const t = await r.text();
      const e = new Error(`Discord ${method} ${path} -> ${r.status}: ${t.slice(0, 300)}`);
      e.status = r.status;
      try { e.code = JSON.parse(t).code; } catch {}
      throw e;
    }
    if (r.status === 204) return null;
    return r.json();
  }
  throw new Error('Discord rate limit exceeded');
}

// Build a multipart body (JSON payload + text file attachments) — FormData is rebuilt per attempt
function toMultipart(body, files) {
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ ...body, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
  files.forEach((f, i) => fd.append(`files[${i}]`, new Blob([f.content], { type: 'text/plain; charset=utf-8' }), f.name));
  return fd;
}

export async function webhookPost(url, body, files) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'wait=true', files?.length
      ? { method: 'POST', body: toMultipart(body, files) }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await sleep(Math.min(10, j.retry_after || 1) * 1000 + 100);
      continue;
    }
    if (!r.ok) throw new Error(`Webhook ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json().catch(() => null);
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

let cachedKey;
export async function verifyRequest(request, publicKey) {
  const sig = request.headers.get('x-signature-ed25519');
  const ts = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  if (!sig || !ts) return null;
  try {
    if (!cachedKey) cachedKey = await crypto.subtle.importKey('raw', hexToBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify('Ed25519', cachedKey, hexToBytes(sig), new TextEncoder().encode(ts + body));
    return ok ? body : null;
  } catch {
    return null;
  }
}

export function avatarUrl(user) {
  if (!user) return null;
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
  }
  const idx = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

export function displayName(user) {
  if (!user) return 'Unknown';
  return user.global_name ? `${user.global_name} (@${user.username})` : `@${user.username}`;
}

export function hasPerm(permStr, flag) {
  try { return (BigInt(permStr || '0') & flag) === flag; } catch { return false; }
}

export function colorInt(hex, fallback = 0x5865f2) {
  if (!hex) return fallback;
  const n = parseInt(String(hex).replace('#', ''), 16);
  return Number.isFinite(n) ? n : fallback;
}

export const trunc = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

export async function sendDM(env, userId, body) {
  const ch = await dapi(env, 'POST', '/users/@me/channels', { recipient_id: userId });
  return dapi(env, 'POST', `/channels/${ch.id}/messages`, body);
}

// Edit the original response of an interaction (after a deferred response)
export function editOriginal(env, interaction, body) {
  return fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function followup(env, interaction, body) {
  return fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
