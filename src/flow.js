import { dapi, sendDM, webhookPost, avatarUrl, displayName, colorInt, trunc, DENY_REASONS, hasPerm, PERM } from './discord.js';
import { getConfig, getType, addLog, now, parse } from './db.js';


// "Whitelist" -> "Whitelist Application"; "Blueline Whitelist Application" stays as-is
export const appLabel = (name) => {
  const n = String(name || 'Application').trim();
  return /application$/i.test(n) ? n : `${n} Application`;
};

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
// Approved applicants may only apply again if they currently hold the application's
// "role removed on approval" (e.g. Blueline Non-Whitelist) — i.e. they were un-whitelisted.
async function approvedBlock(env, guildId, typeId, userId, roles) {
  const approved = await env.DB.prepare(
    `SELECT id FROM applications WHERE guild_id=? AND user_id=? AND app_type_id=? AND status='approved' LIMIT 1`
  ).bind(guildId, userId, typeId).first();
  if (!approved) return null;
  const type = await getType(env, typeId);
  if (type?.remove_role_id) {
    if (!roles) {
      try { roles = (await dapi(env, 'GET', `/guilds/${guildId}/members/${userId}`)).roles || []; } catch { roles = []; }
    }
    if (roles.includes(type.remove_role_id)) return null;
  }
  return '✅ Your application has already been **approved** — you can only apply again if your whitelist is removed.';
}

export async function checkEligibility(env, guildId, typeId, userId, roles) {
  const cfg = await getConfig(env, guildId);
  const hours = cfg.cooldown_hours ?? 48;
  const pending = await env.DB.prepare(
    `SELECT id FROM applications WHERE guild_id=? AND user_id=? AND app_type_id=? AND status='submitted' AND cooldown_reset=0 LIMIT 1`
  ).bind(guildId, userId, typeId).first();
  if (pending) return { ok: false, reason: 'You already have an application waiting to be reviewed. Please wait for staff to review it.' };
  const blocked = await approvedBlock(env, guildId, typeId, userId, roles);
  if (blocked) return { ok: false, reason: blocked };
  if (hours > 0) {
    const since = now() - hours * 3600 * 1000;
    // 48h counts from when the applicant STARTED their last application (a denial does not restart it)
    const recent = await env.DB.prepare(
      `SELECT status, COALESCE(started_at, created_at) AS started FROM applications
       WHERE guild_id=? AND user_id=? AND app_type_id=? AND cooldown_reset=0 AND COALESCE(started_at, created_at) > ?
       ORDER BY started DESC LIMIT 1`
    ).bind(guildId, userId, typeId, since).first();
    if (recent) {
      const until = Math.floor((recent.started + hours * 3600 * 1000) / 1000);
      const why = recent.status === 'denied' ? 'Your last application was denied' : 'You recently applied';
      return { ok: false, reason: `⏳ ${why}. You can apply again <t:${until}:R> (<t:${until}:f>) — 48 hours after you started your last application.` };
    }
  }
  return { ok: true };
}

// ---------- start ----------
export async function startApplication(env, guildId, typeId, user, roles) {
  const type = await getType(env, typeId);
  if (!type || type.guild_id !== guildId) return { ok: false, reason: 'That application no longer exists.' };
  if (!type.enabled) return { ok: false, reason: `**${type.name}** applications are currently closed.` };
  if (!type.questions.length) return { ok: false, reason: 'This application has no questions configured yet. Please tell a staff member.' };

  const elig = await checkEligibility(env, guildId, typeId, user.id, roles);
  if (!elig.ok) return elig;

  const guild = await env.DB.prepare('SELECT name FROM guilds WHERE id=?').bind(guildId).first();
  const answers = type.questions.slice(0, MAX_QUESTIONS).map((q) => ({ q, a: null }));
  const existing = await env.DB.prepare('SELECT user_id FROM sessions WHERE user_id=?').bind(user.id).first();

  try {
    await sendDM(env, user.id, {
      embeds: [{
        color: BRAND,
        title: `📝 ${appLabel(type.name)}`,
        description:
          `${type.description ? type.description + '\n\n' : ''}` +
          `You are applying in **${guild?.name || 'the server'}**.\n` +
          `I'll send you **${answers.length}** question${answers.length === 1 ? '' : 's'}, one at a time. Each answer can be up to **${answerCap(answers.map((x) => x.q))}** characters. ` +
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

  return { ok: true, reason: `📬 Check your DMs — your **${appLabel(type.name)}** has started!` };
}

function sendQuestion(env, userId, answers, i) {
  const cap = answerCap(answers.map((x) => x.q));
  return sendDM(env, userId, {
    embeds: [{
      color: BRAND,
      author: { name: `Question ${i + 1} of ${answers.length}` },
      description: `**${trunc(answers[i].q, 4000)}**`,
      footer: { text: `Reply with your answer below (max ${cap} characters).` },
    }],
  });
}

const REVIEW_BUTTONS = [{
  type: 1,
  components: [
    { type: 2, style: 3, label: 'Submit', emoji: { name: '✅' }, custom_id: 'app_submit' },
    { type: 2, style: 1, label: 'Correct', emoji: { name: '✏️' }, custom_id: 'app_correct' },
    { type: 2, style: 4, label: 'Cancel', custom_id: 'app_cancel' },
  ],
}];

// Sends the "review your answers" screen as ONE message with ONE embed.
async function sendReview(env, channelId, answers, typeName) {
  const msg = buildQAMessage(answers, {
    color: AMBER,
    title: `Review your ${appLabel(typeName)}`,
    description: 'Please check your answers below. Choose **Submit** to send it to staff or **Correct** to change an answer.',
  });
  await dapi(env, 'POST', `/channels/${channelId}/messages`, { embeds: msg.embeds, components: REVIEW_BUTTONS });
}

// Discord limits: 6000 chars across all embeds in one message, 25 fields per embed, 1024 per field value.
// Everything must fit in ONE embed, so each answer gets a character limit based on how many questions there are.
const MSG_BUDGET = 5600;   // total for the embed, leaves headroom for the Status line added on approve/deny
const HEAD_RESERVE = 650;  // title, applicant details, author, footer
export const MAX_QUESTIONS = 25;
const qName = (q, i) => trunc(`${i + 1}. ${q}`, 250);

// Max characters per answer so that all answers fit in a single embed
export function answerCap(questions) {
  const qs = questions.slice(0, MAX_QUESTIONS);
  if (!qs.length) return 1000;
  const names = qs.reduce((n, q, i) => n + qName(q, i).length, 0);
  return Math.max(50, Math.min(1000, Math.floor((MSG_BUDGET - HEAD_RESERVE - names) / qs.length)));
}

// Builds ONE embed with every question and its answer underneath, in order.
export function buildQAMessage(answers, head) {
  const list = answers.slice(0, MAX_QUESTIONS);
  const cap = answerCap(list.map((x) => x.q));
  const fields = list.map((x, i) => ({ name: qName(x.q, i), value: trunc(x.a || '*No answer*', cap) }));
  return { embeds: [{ ...head, fields }], files: [] };
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
  const cap = answerCap(answers.map((x) => x.q));
  if (content.length > cap) {
    await dapi(env, 'POST', `/channels/${msg.channel_id}/messages`, { content: `⚠️ That answer is **${content.length}** characters. Each answer can be up to **${cap}** characters so your whole application fits on one page for staff — please shorten it and send it again.` });
    return;
  }

  const type = await getType(env, s.app_type_id);
  const typeName = type?.name || 'Application';

  if (s.editing !== null && s.editing !== undefined) {
    answers[s.editing].a = content;
    await env.DB.prepare('UPDATE sessions SET answers=?, editing=NULL WHERE user_id=?').bind(JSON.stringify(answers), userId).run();
    await sendReview(env, msg.channel_id, answers, typeName);
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
  else await sendReview(env, msg.channel_id, answers, typeName);
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

  // never resubmit for someone who has already been approved for this application
  const already = await approvedBlock(env, s.guild_id, s.app_type_id, user.id);
  if (already) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id).run();
    return { content: already + ' This application was not sent again.', embeds: [], components: [] };
  }

  // delete session first to stop double submits
  const del = await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id).run();
  if (!del.meta?.changes) return { content: 'This application was already submitted.', embeds: [], components: [] };

  const type = await getType(env, s.app_type_id);
  const cfg = await getConfig(env, s.guild_id);
  const avatar = avatarUrl(user);
  const name = displayName(user);

  const ins = await env.DB.prepare(
    `INSERT INTO applications (guild_id, app_type_id, app_name, user_id, username, avatar_url, answers, status, created_at, started_at) VALUES (?,?,?,?,?,?,?, 'submitted', ?, ?)`
  ).bind(s.guild_id, s.app_type_id, type?.name || 'Application', user.id, name, avatar, JSON.stringify(answers), now(), s.started_at || now()).run();
  const appId = ins.meta.last_row_id;
  await addLog(env, { guild_id: s.guild_id, application_id: appId, action: 'submitted', actor_id: user.id, actor_name: name, target_id: user.id, detail: type?.name });

  const msg = submissionMessage({ id: appId, app_name: type?.name || 'Application', user_id: user.id, username: name, avatar_url: avatar, answers, created_at: now() });

  // 1) webhook (as requested)
  const hook = cfg.webhook_url || env.DEFAULT_WEBHOOK_URL;
  // if the review channel is the same channel the webhook posts into, only post once (the bot message with buttons)
  const sameChannel = !!(hook && cfg.review_channel_id && (await webhookChannelId(hook)) === cfg.review_channel_id);
  if (hook && !sameChannel) {
    // ping roles where staff review: the review channel if set, otherwise the webhook post
    try { await postToWebhook(hook, msg, cfg.review_channel_id ? null : pingFor(cfg, name)); } catch (e) { console.log('webhook failed', e.message); }
  }
  // 2) review channel with Approve / Deny buttons
  if (cfg.review_channel_id) {
    try {
      const m = await postReviewMessage(env, cfg.review_channel_id, msg, appId, pingFor(cfg, name));
      await env.DB.prepare('UPDATE applications SET review_channel_id=?, review_message_id=? WHERE id=?').bind(cfg.review_channel_id, m.id, appId).run();
    } catch (e) { console.log('review post failed', e.message); }
  }

  return {
    content: '',
    embeds: [{ color: GREEN, title: '✅ Application submitted', description: `Your **${appLabel(type?.name)}** (#${appId}) has been sent to staff. You'll get a DM here once it has been reviewed.` }],
    components: [],
  };
}

// Submit questionnaires that are fully answered but stuck waiting on the review buttons
export async function submitCompletedSessions(env, guildId) {
  const { results } = await env.DB.prepare('SELECT * FROM sessions WHERE guild_id=?').bind(guildId).all();
  const done = [];
  for (const s of results) {
    const answers = parse(s.answers, []);
    if (!answers.length || answers.some((x) => !x.a)) continue;
    try {
      const user = await dapi(env, 'GET', `/users/${s.user_id}`);
      const res = await onSubmit(env, user);
      await sendDM(env, user.id, { content: res.content || undefined, embeds: res.embeds || [] }).catch(() => {});
      done.push(displayName(user));
    } catch (e) { console.log('force submit failed', s.user_id, e.message); }
  }
  return done;
}

export function submissionMessage(app) {
  const answers = typeof app.answers === 'string' ? parse(app.answers, []) : app.answers;
  return buildQAMessage(answers, {
    color: BRAND,
    author: { name: app.username, icon_url: app.avatar_url },
    title: `${appLabel(app.app_name)} #${app.id}`,
    thumbnail: { url: app.avatar_url },
    description: `**Applicant:** <@${app.user_id}>\n**Discord:** ${app.username}\n**User ID:** \`${app.user_id}\`\n**Submitted:** <t:${Math.floor(app.created_at / 1000)}:f>`,
    timestamp: new Date(app.created_at).toISOString(),
    footer: { text: 'Blueline Whitelist Applications' },
  });
}

// Which channel a webhook posts into (public info on the webhook URL, no auth needed)
const hookChannelCache = new Map();
export async function webhookChannelId(url) {
  if (!url) return null;
  if (hookChannelCache.has(url)) return hookChannelCache.get(url);
  try {
    const r = await fetch(url.split('?')[0]);
    const j = r.ok ? await r.json() : null;
    const id = j?.channel_id || null;
    hookChannelCache.set(url, id);
    return id;
  } catch { return null; }
}

// Role ping line for new submissions (approver + staff roles, no duplicates)
function pingFor(cfg, name) {
  const roles = [...new Set([...(cfg.approver_roles || []), ...(cfg.staff_roles || [])])].filter((r) => /^\d+$/.test(r));
  if (!roles.length) return { content: undefined, allowed_mentions: { parse: [] } };
  return {
    content: `${roles.map((r) => `<@&${r}>`).join(' ')} — new application from **${trunc(name, 100)}** is waiting for review.`,
    allowed_mentions: { parse: [], roles },
  };
}

async function postToWebhook(url, msg, ping) {
  await webhookPost(url, { username: 'Applications', embeds: msg.embeds, ...(ping || { allowed_mentions: { parse: [] } }) }, msg.files);
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

async function postReviewMessage(env, channelId, msg, appId, ping) {
  return dapi(env, 'POST', `/channels/${channelId}/messages`, { embeds: msg.embeds, components: reviewButtons(appId), ...(ping || { allowed_mentions: { parse: [] } }) }, { files: msg.files });
}

// Post Approve/Deny messages for pending applications that don't have one yet (e.g. review channel set later)
export async function backfillReview(env, guildId) {
  const cfg = await getConfig(env, guildId);
  if (!cfg.review_channel_id) return 0;
  const { results } = await env.DB.prepare(
    `SELECT * FROM applications WHERE guild_id=? AND status='submitted' AND (review_message_id IS NULL OR review_channel_id IS NOT ?) ORDER BY id LIMIT 25`
  ).bind(guildId, cfg.review_channel_id).all();
  let n = 0;
  for (const app of results) {
    try {
      const m = await postReviewMessage(env, cfg.review_channel_id, submissionMessage(app), app.id, pingFor(cfg, app.username));
      await env.DB.prepare('UPDATE applications SET review_channel_id=?, review_message_id=? WHERE id=?').bind(cfg.review_channel_id, m.id, app.id).run();
      n++;
    } catch (e) { console.log('backfill failed', e.message); }
  }
  return n;
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
        ? `🎉 Congratulations! Your **${appLabel(app.app_name)}** for **${guild?.name || 'the server'}** has been **approved**.\n\nWelcome to the community — you now have access. See you in the city!`
        : `Unfortunately, your **${appLabel(app.app_name)}** for **${guild?.name || 'the server'}** has been **denied**.\n\n**Reason:** ${reason}\n\nYou can apply again once your 48-hour cooldown has passed.`,
      timestamp: new Date().toISOString(),
    }],
  }).catch((e) => console.log('dm fail', e.message)));

  // accept role
  if (approved && app.app_type_id) {
    const type = await getType(env, app.app_type_id);
    const why = { reason: `Application #${appId} approved by ${actor.name}` };
    if (type?.accept_role_id) {
      tasks.push(dapi(env, 'PUT', `/guilds/${app.guild_id}/members/${app.user_id}/roles/${type.accept_role_id}`, undefined, why).catch((e) => console.log('role add fail', e.message)));
    }
    if (type?.remove_role_id && type.remove_role_id !== type.accept_role_id) {
      tasks.push(dapi(env, 'DELETE', `/guilds/${app.guild_id}/members/${app.user_id}/roles/${type.remove_role_id}`, undefined, why).catch((e) => console.log('role remove fail', e.message)));
    }
  }

  // log to webhook
  const cfg = await getConfig(env, app.guild_id);
  const hook = cfg.webhook_url || env.DEFAULT_WEBHOOK_URL;
  const decisionEmbed = {
    color: approved ? GREEN : RED,
    author: { name: app.username, icon_url: app.avatar_url },
    title: `${appLabel(app.app_name)} #${appId} ${approved ? 'Approved' : 'Denied'}`,
    thumbnail: { url: app.avatar_url },
    fields: [
      { name: 'Applicant', value: `<@${app.user_id}> (${trunc(app.username, 200)})`, inline: true },
      { name: approved ? 'Approved by' : 'Denied by', value: `<@${actor.id}> (${trunc(actor.name, 200)})`, inline: true },
      ...(reason ? [{ name: 'Reason', value: reason }] : []),
    ],
    timestamp: new Date().toISOString(),
  };
  // decision log to the webhook — skipped when the review message (which gets updated) lives in that same channel
  const sameChannel = !!(hook && app.review_channel_id && (await webhookChannelId(hook)) === app.review_channel_id);
  if (hook && !sameChannel) tasks.push(webhookPost(hook, { username: 'Applications', embeds: [decisionEmbed], allowed_mentions: { parse: [] } }).catch((e) => console.log('hook fail', e.message)));

  // update review message
  if (app.review_channel_id && app.review_message_id) {
    tasks.push(
      dapi(env, 'GET', `/channels/${app.review_channel_id}/messages/${app.review_message_id}`)
        .then((m) => {
          const e = m.embeds?.[0] || {};
          e.color = approved ? GREEN : RED;
          const status = approved ? `✅ **Approved** by <@${actor.id}>` : `⛔ **Denied** by <@${actor.id}> — ${reason}`;
          e.description = `${status}\n\n${e.description || ''}`.slice(0, 4096);
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
// Defaults (taken from the original Blueline Britain whitelist panel) used for any
// field left blank when a panel is created with /panel or from the dashboard.
export const PANEL_DEFAULTS = {
  title: 'Blueline Britain - Whitelist Applications',
  description: 'Want to join **Blueline Britain**? Click **Apply** below to start your whitelist application.\n\n📬 The questions will be sent to your **DMs** one at a time - make sure your DMs are open.\n✏️ You can correct any answer before you submit.\n🔞 Minimum age: **16+**\n⏳ You can only apply once every **48 hours**.',
  color: '#2f7bff',
  image_url: 'https://media.discordapp.net/attachments/1527194711918379019/1562966791964069978/myLogo.png?ex=6afe30c1&is=6afcdf41&hm=395cf700dd4303fccefce1e2552bdd95a24b69017c2a416a987aa59f037404d4&format=webp&quality=lossless&width=384&height=349',
};
const blank = (v) => v == null || String(v).trim() === '';
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
      color: colorInt(blank(panel.color) ? PANEL_DEFAULTS.color : panel.color),
      title: trunc(blank(panel.title) ? PANEL_DEFAULTS.title : String(panel.title).trim(), 256),
      description: trunc(blank(panel.description) ? PANEL_DEFAULTS.description : panel.description, 4000),
      image: { url: blank(panel.image_url) ? PANEL_DEFAULTS.image_url : panel.image_url },
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
