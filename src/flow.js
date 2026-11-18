import { dapi, sendDM, webhookPost, avatarUrl, displayName, colorInt, trunc, DENY_REASONS, hasPerm, PERM } from './discord.js';
import { getConfig, getType, addLog, now, parse } from './db.js';

const BRAND = 0x5865f2;
const GREEN = 0x2ecc71;
const RED = 0xe74c3c;
const AMBER = 0xf1c40f;

// ---------- permission helpers ----------
export function canApprove(cfg, roles, permissions) {
  if (cfg.approver_roles.some((r) => roles.includes(r))) return true;
  return hasPerm(permissions, PERM.ADMIN);
}
export function canReset(cfg, roles, permissions) {
  if (cfg.staff_roles.some((r) => roles.includes(r))) return true;
  return hasPerm(permissions, PERM.ADMIN);
}

// ---------- cooldown ----------
export async function checkEligibility(env, guildId, typeId, userId) {
  const cfg = await getConfig(env, guildId);
  const hours = cfg.cooldown_hours ?? 48;
  const pending = await env.DB.prepare(
    `SELECT id FROM applications WHERE guild_id=? AND user_id=? AND app_type_id=? AND status='submitted' AND cooldown_reset=0 LIMIT 1`
  ).bind(guildId, userId, typeId).first();
  if (pending) return { ok: false, reason: 'You already have an application waiting to be reviewed. Please wait for staff to review it.' };
  if (hours > 0) {
    const since = now() - hours * 3600 * 1000;
    const recent = await env.DB.prepare(
      `SELECT created_at FROM applications WHERE guild_id=? AND user_id=? AND app_type_id=? AND cooldown_reset=0 AND created_at > ? ORDER BY created_at DESC LIMIT 1`
    ).bind(guildId, userId, typeId, since).first();
    if (recent) {
      const until = Math.floor((recent.created_at + hours * 3600 * 1000) / 1000);
      return { ok: false, reason: `You recently submitted this application. You can reapply <t:${until}:R> (<t:${until}:f>).` };
    }
  }
  return { ok: true };
}

// ---------- start ----------
export async function startApplication(env, guildId, typeId, user) {
  const type = await getType(env, typeId);
  if (!type || type.guild_id !== guildId) return { ok: false, reason: 'That application no longer exists.' };
  if (!type.enabled) return { ok: false, reason: `**${type.name}** applications are currently closed.` };
  if (!type.questions.length) return { ok: false, reason: 'This application has no questions configured yet. Please tell a staff member.' };

  const elig = await checkEligibility(env, guildId, typeId, user.id);
  if (!elig.ok) return elig;

  const guild = await env.DB.prepare('SELECT name FROM guilds WHERE id=?').bind(guildId).first();
  const answers = type.questions.map((q) => ({ q, a: null }));
  const existing = await env.DB.prepare('SELECT user_id FROM sessions WHERE user_id=?').bind(user.id).first();

  try {
    await sendDM(env, user.id, {
      embeds: [{
        color: BRAND,
        title: `📝 ${type.name} Application`,
        description:
          `${type.description ? type.description + '\n\n' : ''}` +
          `You are applying in **${guild?.name || 'the server'}**.\n` +
          `I'll send you **${answers.length}** question${answers.length === 1 ? '' : 's'}, one at a time. ` +
          `Simply type your answer and send it as a message. At the end you'll be able to **correct** any answer before you **submit**.` +
          (existing ? '\n\n_Your previous unfinished application has been replaced by this one._' : ''),
        footer: { text: 'Type "cancel" at any time to stop.' },
      }],
    });
    await sendQuestion(env, user.id, answers, 0);
  } catch (e) {
    if (e.code === 50007 || e.code === 50278) return { ok: false, reason: "I couldn't DM you, so your application can't start.\n\n**To fix:** right-click the server icon → **Privacy Settings** → turn on **Direct Messages**, then press Apply again.\n_If that's already on, the server may have DMs paused — let a staff member know._" };
    throw e;
  }

  await env.DB.prepare(
    `INSERT INTO sessions (user_id, guild_id, app_type_id, answers, step, editing, started_at) VALUES (?,?,?,?,0,NULL,?)
     ON CONFLICT(user_id) DO UPDATE SET guild_id=excluded.guild_id, app_type_id=excluded.app_type_id, answers=excluded.answers, step=0, editing=NULL, started_at=excluded.started_at`
  ).bind(user.id, guildId, typeId, JSON.stringify(answers), now()).run();

  return { ok: true, reason: `📬 Check your DMs — your **${type.name}** application has started!` };
}

function sendQuestion(env, userId, answers, i) {
  return sendDM(env, userId, {
    embeds: [{
      color: BRAND,
      author: { name: `Question ${i + 1} of ${answers.length}` },
      description: `**${trunc(answers[i].q, 4000)}**`,
      footer: { text: 'Reply with your answer below.' },
    }],
  });
}

function reviewPayload(answers, typeName) {
  const embeds = buildQAEmbeds(answers, {
    color: AMBER,
    title: `Review your ${typeName} application`,
    description: 'Please check your answers below. Choose **Submit** to send it to staff or **Correct** to change an answer.',
  });
  return {
    embeds: embeds.slice(0, 10),
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Submit', emoji: { name: '✅' }, custom_id: 'app_submit' },
        { type: 2, style: 1, label: 'Correct', emoji: { name: '✏️' }, custom_id: 'app_correct' },
        { type: 2, style: 4, label: 'Cancel', custom_id: 'app_cancel' },
      ],
    }],
  };
}

// Builds one or more embeds holding Q&A fields, respecting Discord limits
export function buildQAEmbeds(answers, head) {
  const embeds = [];
  let cur = { ...head, fields: [] };
  let size = (head.title?.length || 0) + (head.description?.length || 0) + 100;
  answers.forEach((x, i) => {
    const name = trunc(`${i + 1}. ${x.q}`, 256);
    const value = trunc(x.a || '*No answer*', 1024);
    if (cur.fields.length >= 25 || size + name.length + value.length > 5800) {
      embeds.push(cur);
      cur = { color: head.color, fields: [] };
      size = 0;
    }
    cur.fields.push({ name, value });
    size += name.length + value.length;
  });
  embeds.push(cur);
  return embeds;
}

// ---------- DM message handler (called from gateway) ----------
export async function handleDM(env, msg) {
  const userId = msg.author.id;
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE user_id=?').bind(userId).first();
  if (!s) return;
  const answers = parse(s.answers, []);
  let content = (msg.content || '').trim();
  if (!content && msg.attachments?.length) content = msg.attachments.map((a) => a.url).join('\n');
  if (!content) return;

  if (content.toLowerCase() === 'cancel') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId).run();
    await dapi(env, 'POST', `/channels/${msg.channel_id}/messages`, { content: '❌ Your application has been cancelled. You can start again from the server at any time.' });
    return;
  }
  if (content.length > 1000) {
    await dapi(env, 'POST', `/channels/${msg.channel_id}/messages`, { content: `⚠️ That answer is ${content.length} characters long. Please keep each answer under **1000** characters and send it again.` });
    return;
  }

  const type = await getType(env, s.app_type_id);
  const typeName = type?.name || 'Application';

  if (s.editing !== null && s.editing !== undefined) {
    answers[s.editing].a = content;
    await env.DB.prepare('UPDATE sessions SET answers=?, editing=NULL WHERE user_id=?').bind(JSON.stringify(answers), userId).run();
    await dapi(env, 'POST', `/channels/${msg.channel_id}/messages`, reviewPayload(answers, typeName));
    return;
  }

  const step = s.step;
  if (step >= answers.length) {
    // all answered, waiting on buttons
    await dapi(env, 'POST', `/channels/${msg.channel_id}/messages`, { content: 'Please use the **Submit** or **Correct** buttons on the review message above.' });
    return;
  }
  answers[step].a = content;
  const next = step + 1;
  await env.DB.prepare('UPDATE sessions SET answers=?, step=? WHERE user_id=?').bind(JSON.stringify(answers), next, userId).run();
  if (next < answers.length) await sendQuestion(env, userId, answers, next);
  else await dapi(env, 'POST', `/channels/${msg.channel_id}/messages`, reviewPayload(answers, typeName));
}

// ---------- DM button handlers ----------
export async function onCorrect(env, userId) {
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE user_id=?').bind(userId).first();
  if (!s) return { content: 'You have no application in progress.', components: [] };
  const answers = parse(s.answers, []);
  return {
    content: '✏️ Which question would you like to correct?',
    embeds: [],
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: 'app_correct_pick',
        placeholder: 'Select a question',
        options: answers.slice(0, 25).map((x, i) => ({ label: trunc(`Q${i + 1}: ${x.q}`, 100), description: trunc(x.a || '', 100) || undefined, value: String(i) })),
      }],
    }],
  };
}

export async function onCorrectPick(env, userId, idx) {
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE user_id=?').bind(userId).first();
  if (!s) return { content: 'You have no application in progress.', components: [] };
  const answers = parse(s.answers, []);
  if (!answers[idx]) return { content: 'Invalid question.', components: [] };
  await env.DB.prepare('UPDATE sessions SET editing=? WHERE user_id=?').bind(idx, userId).run();
  return {
    content: '',
    embeds: [{
      color: BRAND,
      author: { name: `Editing Question ${idx + 1}` },
      description: `**${trunc(answers[idx].q, 3500)}**\n\n__Current answer:__\n${trunc(answers[idx].a || '*none*', 400)}\n\nSend your **new answer** as a message.`,
    }],
    components: [],
  };
}

export async function onCancel(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId).run();
  return { content: '❌ Application cancelled.', embeds: [], components: [] };
}

export async function onSubmit(env, user) {
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE user_id=?').bind(user.id).first();
  if (!s) return { content: 'This application was already submitted or cancelled.', embeds: [], components: [] };
  const answers = parse(s.answers, []);
  if (answers.some((x) => !x.a)) return { content: 'Please answer every question before submitting.', components: [] };

  // delete session first to stop double submits
  const del = await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id).run();
  if (!del.meta?.changes) return { content: 'This application was already submitted.', embeds: [], components: [] };

  const type = await getType(env, s.app_type_id);
  const cfg = await getConfig(env, s.guild_id);
  const avatar = avatarUrl(user);
  const name = displayName(user);

  const ins = await env.DB.prepare(
    `INSERT INTO applications (guild_id, app_type_id, app_name, user_id, username, avatar_url, answers, status, created_at) VALUES (?,?,?,?,?,?,?, 'submitted', ?)`
  ).bind(s.guild_id, s.app_type_id, type?.name || 'Application', user.id, name, avatar, JSON.stringify(answers), now()).run();
  const appId = ins.meta.last_row_id;
  await addLog(env, { guild_id: s.guild_id, application_id: appId, action: 'submitted', actor_id: user.id, actor_name: name, target_id: user.id, detail: type?.name });

  const embeds = submissionEmbeds({ id: appId, app_name: type?.name || 'Application', user_id: user.id, username: name, avatar_url: avatar, answers, created_at: now() });

  // 1) webhook (as requested)
  const hook = cfg.webhook_url || env.DEFAULT_WEBHOOK_URL;
  if (hook) {
    try { await postEmbedsToWebhook(hook, embeds); } catch (e) { console.log('webhook failed', e.message); }
  }
  // 2) review channel with Approve / Deny buttons
  if (cfg.review_channel_id) {
    try {
      const m = await postReviewMessage(env, cfg.review_channel_id, embeds, appId);
      await env.DB.prepare('UPDATE applications SET review_channel_id=?, review_message_id=? WHERE id=?').bind(cfg.review_channel_id, m.id, appId).run();
    } catch (e) { console.log('review post failed', e.message); }
  }

  return {
    content: '',
    embeds: [{ color: GREEN, title: '✅ Application submitted', description: `Your **${type?.name || ''}** application (#${appId}) has been sent to staff. You'll get a DM here once it has been reviewed.` }],
    components: [],
  };
}

export function submissionEmbeds(app) {
  const answers = typeof app.answers === 'string' ? parse(app.answers, []) : app.answers;
  return buildQAEmbeds(answers, {
    color: BRAND,
    author: { name: app.username, icon_url: app.avatar_url },
    title: `${app.app_name} Application #${app.id}`,
    thumbnail: { url: app.avatar_url },
    description: `**Applicant:** <@${app.user_id}>\n**Discord:** ${app.username}\n**User ID:** \`${app.user_id}\`\n**Submitted:** <t:${Math.floor(app.created_at / 1000)}:f>`,
    timestamp: new Date(app.created_at).toISOString(),
    footer: { text: 'Blueline Whitelist Applications' },
  });
}

async function postEmbedsToWebhook(url, embeds) {
  // max 10 embeds & 6000 chars per message — send each embed group separately to be safe
  for (const e of embeds) await webhookPost(url, { username: 'Applications', embeds: [e], allowed_mentions: { parse: [] } });
}

function reviewButtons(appId) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Approve', emoji: { name: '✅' }, custom_id: `rv_ap:${appId}` },
      { type: 2, style: 4, label: 'Deny', emoji: { name: '⛔' }, custom_id: `rv_dn:${appId}` },
    ],
  }];
}

async function postReviewMessage(env, channelId, embeds, appId) {
  let first;
  for (let i = 0; i < embeds.length; i++) {
    const last = i === embeds.length - 1;
    const m = await dapi(env, 'POST', `/channels/${channelId}/messages`, { embeds: [embeds[i]], components: last ? reviewButtons(appId) : [], allowed_mentions: { parse: [] } });
    if (last) first = m;
  }
  return first;
}

export function denyReasonMenu(appId) {
  return [{
    type: 1,
    components: [{
      type: 3,
      custom_id: `rv_dr:${appId}`,
      placeholder: 'Select a reason for denying (required)',
      min_values: 1,
      max_values: 1,
      options: DENY_REASONS.map((r, i) => ({ label: r, value: String(i) })),
    }],
  }];
}

// ---------- decision ----------
export async function decide(env, appId, decision, reasonIdx, actor) {
  const app = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(appId).first();
  if (!app) return { ok: false, error: 'Application not found.' };
  if (app.status !== 'submitted') return { ok: false, error: `Application #${appId} was already ${app.status}.` };
  let reason = null;
  if (decision === 'denied') {
    reason = DENY_REASONS[Number(reasonIdx)];
    if (!reason) return { ok: false, error: 'A valid deny reason must be selected.' };
  } else if (decision !== 'approved') return { ok: false, error: 'Invalid decision.' };

  const upd = await env.DB.prepare(`UPDATE applications SET status=?, deny_reason=?, reviewer_id=?, reviewer_name=?, decided_at=? WHERE id=? AND status='submitted'`)
    .bind(decision, reason, actor.id, actor.name, now(), appId).run();
  if (!upd.meta?.changes) return { ok: false, error: 'Application was already decided.' };
  await addLog(env, { guild_id: app.guild_id, application_id: appId, action: decision, actor_id: actor.id, actor_name: actor.name, target_id: app.user_id, detail: reason || app.app_name });

  const guild = await env.DB.prepare('SELECT name FROM guilds WHERE id=?').bind(app.guild_id).first();
  const approved = decision === 'approved';
  const tasks = [];

  // DM applicant
  tasks.push(sendDM(env, app.user_id, {
    embeds: [{
      color: approved ? GREEN : RED,
      title: approved ? '✅ Application Approved' : '⛔ Application Denied',
      description: approved
        ? `Congratulations! Your **${app.app_name}** application in **${guild?.name || 'the server'}** has been **approved**.`
        : `Your **${app.app_name}** application in **${guild?.name || 'the server'}** has been **denied**.\n\n**Reason:** ${reason}`,
      timestamp: new Date().toISOString(),
    }],
  }).catch((e) => console.log('dm fail', e.message)));

  // accept role
  if (approved && app.app_type_id) {
    const type = await getType(env, app.app_type_id);
    if (type?.accept_role_id) {
      tasks.push(dapi(env, 'PUT', `/guilds/${app.guild_id}/members/${app.user_id}/roles/${type.accept_role_id}`, undefined, { reason: `Application #${appId} approved by ${actor.name}` }).catch((e) => console.log('role fail', e.message)));
    }
  }

  // log to webhook
  const cfg = await getConfig(env, app.guild_id);
  const hook = cfg.webhook_url || env.DEFAULT_WEBHOOK_URL;
  const decisionEmbed = {
    color: approved ? GREEN : RED,
    author: { name: app.username, icon_url: app.avatar_url },
    title: `${app.app_name} Application #${appId} ${approved ? 'Approved' : 'Denied'}`,
    thumbnail: { url: app.avatar_url },
    fields: [
      { name: 'Applicant', value: `<@${app.user_id}> (${trunc(app.username, 200)})`, inline: true },
      { name: approved ? 'Approved by' : 'Denied by', value: `<@${actor.id}> (${trunc(actor.name, 200)})`, inline: true },
      ...(reason ? [{ name: 'Reason', value: reason }] : []),
    ],
    timestamp: new Date().toISOString(),
  };
  if (hook) tasks.push(webhookPost(hook, { username: 'Applications', embeds: [decisionEmbed], allowed_mentions: { parse: [] } }).catch((e) => console.log('hook fail', e.message)));

  // update review message
  if (app.review_channel_id && app.review_message_id) {
    tasks.push(
      dapi(env, 'GET', `/channels/${app.review_channel_id}/messages/${app.review_message_id}`)
        .then((m) => {
          const e = m.embeds?.[0] || {};
          e.color = approved ? GREEN : RED;
          e.fields = [...(e.fields || []), { name: 'Status', value: approved ? `✅ Approved by <@${actor.id}>` : `⛔ Denied by <@${actor.id}>\n**Reason:** ${reason}` }];
          return dapi(env, 'PATCH', `/channels/${app.review_channel_id}/messages/${app.review_message_id}`, { embeds: [e, ...(m.embeds || []).slice(1)], components: [] });
        })
        .catch((e) => console.log('review edit fail', e.message))
    );
  }
  await Promise.all(tasks);
  return { ok: true, app: { ...app, status: decision, deny_reason: reason } };
}

// ---------- reset ----------
export async function resetUser(env, guildId, userId, actor) {
  const r = await env.DB.prepare('UPDATE applications SET cooldown_reset=1 WHERE guild_id=? AND user_id=? AND cooldown_reset=0').bind(guildId, userId).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND guild_id=?').bind(userId, guildId).run();
  await addLog(env, { guild_id: guildId, action: 'reset', actor_id: actor.id, actor_name: actor.name, target_id: userId, detail: `${r.meta?.changes || 0} application(s) reset` });
  const guild = await env.DB.prepare('SELECT name FROM guilds WHERE id=?').bind(guildId).first();
  await sendDM(env, userId, {
    embeds: [{ color: BRAND, title: '🔄 Application status reset', description: `A staff member in **${guild?.name || 'the server'}** has reset your whitelist application status. You can now apply again straight away.` }],
  }).catch(() => {});
  return { ok: true, changed: r.meta?.changes || 0 };
}

// ---------- panels ----------
export async function buildPanelMessage(env, panel) {
  const ids = parse(panel.app_type_ids, []);
  let types = [];
  if (ids.length) {
    const { results } = await env.DB.prepare(`SELECT id, name, button_style, enabled FROM app_types WHERE guild_id=? AND id IN (${ids.map(() => '?').join(',')})`).bind(panel.guild_id, ...ids).all();
    types = ids.map((id) => results.find((r) => r.id === Number(id))).filter(Boolean);
  }
  const buttons = types.slice(0, 25).map((t) => ({ type: 2, style: [1, 2, 3, 4].includes(t.button_style) ? t.button_style : 1, label: trunc(t.name, 80), custom_id: `apply:${t.id}`, disabled: !t.enabled }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  return {
    embeds: [{
      color: colorInt(panel.color),
      title: trunc(panel.title || 'Applications', 256),
      description: trunc(panel.description || 'Click a button below to start an application. The questions will be sent to your DMs.', 4000),
      ...(panel.image_url ? { image: { url: panel.image_url } } : {}),
      footer: { text: 'Blueline Whitelist Applications' },
    }],
    components: rows,
  };
}

export async function postPanel(env, panel) {
  const body = await buildPanelMessage(env, panel);
  if (panel.message_id && panel.channel_id) {
    try {
      await dapi(env, 'PATCH', `/channels/${panel.channel_id}/messages/${panel.message_id}`, body);
      return panel.message_id;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  const m = await dapi(env, 'POST', `/channels/${panel.channel_id}/messages`, body);
  await env.DB.prepare('UPDATE panels SET message_id=? WHERE id=?').bind(m.id, panel.id).run();
  return m.id;
}
