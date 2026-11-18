export const now = () => Date.now();

export const parse = (s, d) => {
  try { return s == null ? d : JSON.parse(s); } catch { return d; }
};

export async function getConfig(env, guildId) {
  const row = await env.DB.prepare('SELECT * FROM guild_config WHERE guild_id = ?').bind(guildId).first();
  return {
    guild_id: guildId,
    approver_roles: parse(row?.approver_roles, []),
    staff_roles: parse(row?.staff_roles, []),
    webhook_url: row?.webhook_url || '',
    review_channel_id: row?.review_channel_id || '',
    cooldown_hours: row?.cooldown_hours ?? 48,
  };
}

export async function saveConfig(env, guildId, c) {
  await env.DB.prepare(
    `INSERT INTO guild_config (guild_id, approver_roles, staff_roles, webhook_url, review_channel_id, cooldown_hours, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET approver_roles=excluded.approver_roles, staff_roles=excluded.staff_roles,
       webhook_url=excluded.webhook_url, review_channel_id=excluded.review_channel_id, cooldown_hours=excluded.cooldown_hours, updated_at=excluded.updated_at`
  ).bind(
    guildId,
    JSON.stringify(c.approver_roles || []),
    JSON.stringify(c.staff_roles || []),
    c.webhook_url || null,
    c.review_channel_id || null,
    Number.isFinite(+c.cooldown_hours) ? Math.max(0, Math.floor(+c.cooldown_hours)) : 48,
    now()
  ).run();
}

export async function getType(env, id) {
  const t = await env.DB.prepare('SELECT * FROM app_types WHERE id = ?').bind(id).first();
  if (!t) return null;
  t.questions = parse(t.questions, []);
  return t;
}

export async function listTypes(env, guildId) {
  const { results } = await env.DB.prepare('SELECT * FROM app_types WHERE guild_id = ? ORDER BY id').bind(guildId).all();
  return results.map((t) => ({ ...t, questions: parse(t.questions, []) }));
}

export async function addLog(env, l) {
  await env.DB.prepare(
    'INSERT INTO logs (guild_id, application_id, action, actor_id, actor_name, target_id, detail, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(l.guild_id || null, l.application_id || null, l.action, l.actor_id || null, l.actor_name || null, l.target_id || null, l.detail || null, now()).run();
}

export async function kvGet(env, k) {
  const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return r?.v ?? null;
}
export async function kvSet(env, k, v) {
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run();
}
