import { verifyRequest, editOriginal, followup, displayName, trunc, dapi, brand } from './discord.js';
import { getConfig, saveConfig, listTypes, getType, addLog, now } from './db.js';
import {
  startApplication, onCorrect, onCorrectPick, onCancel, onSubmit, decide, denyReasonMenu,
  resetUser, canApprove, canReset, postPanel, backfillReview,
} from './flow.js';

const EPHEMERAL = 64;

export const COMMANDS = [
  {
    name: 'setup',
    description: 'Configure the application bot for this server',
    default_member_permissions: '32',
    dm_permission: false,
    options: [
      { type: 8, name: 'approver_role', description: 'Role allowed to approve / deny applications', required: true },
      { type: 8, name: 'staff_role', description: 'Role allowed to reset application status (bypass 48h wait)', required: true },
      { type: 7, name: 'review_channel', description: 'Channel where submissions appear with Approve / Deny buttons', required: false, channel_types: [0, 5] },
      { type: 3, name: 'webhook_url', description: 'Discord webhook URL for submitted applications (optional override)', required: false },
      { type: 4, name: 'cooldown_hours', description: 'Hours before someone can reapply (default 48)', required: false, min_value: 0, max_value: 720 },
    ],
  },
  {
    name: 'application',
    description: 'Manage application types',
    default_member_permissions: '32',
    dm_permission: false,
    options: [
      {
        type: 1, name: 'create', description: 'Create a new application type',
        options: [
          { type: 3, name: 'name', description: 'e.g. Whitelist, Police, EMS', required: true, max_length: 80 },
          { type: 3, name: 'description', description: 'Shown to the applicant before the questions', required: false, max_length: 1000 },
          { type: 8, name: 'accept_role', description: 'Role given automatically when approved', required: false },
          { type: 8, name: 'remove_role', description: 'Role removed automatically when approved', required: false },
        ],
      },
      {
        type: 1, name: 'add-question', description: 'Add a question to an application',
        options: [
          { type: 4, name: 'application', description: 'Application', required: true, autocomplete: true },
          { type: 3, name: 'question', description: 'The question text', required: true, max_length: 1000 },
        ],
      },
      {
        type: 1, name: 'remove-question', description: 'Remove a question by number',
        options: [
          { type: 4, name: 'application', description: 'Application', required: true, autocomplete: true },
          { type: 4, name: 'number', description: 'Question number (1 = first)', required: true, min_value: 1 },
        ],
      },
      {
        type: 1, name: 'toggle', description: 'Open or close an application',
        options: [{ type: 4, name: 'application', description: 'Application', required: true, autocomplete: true }],
      },
      { type: 1, name: 'list', description: 'List application types and their questions' },
    ],
  },
  {
    name: 'panel',
    description: 'Post an application panel with Apply buttons',
    default_member_permissions: '32',
    dm_permission: false,
    options: [
      { type: 7, name: 'channel', description: 'Channel to post the panel in', required: true, channel_types: [0, 5] },
      { type: 3, name: 'title', description: 'Panel title', required: false, max_length: 256 },
      { type: 3, name: 'description', description: 'Panel text', required: false, max_length: 2000 },
      { type: 3, name: 'color', description: 'Hex colour e.g. #5865F2', required: false },
    ],
  },
  {
    name: 'apply',
    description: 'Start an application',
    dm_permission: false,
    options: [{ type: 4, name: 'application', description: 'Which application', required: true, autocomplete: true }],
  },
  {
    name: 'reset-application',
    description: 'Reset a user\'s application status so they can reapply now (staff only)',
    dm_permission: false,
    options: [{ type: 6, name: 'user', description: 'The applicant', required: true }],
  },
  { name: 'dashboard', description: 'Get the link to the applications dashboard', dm_permission: false },
];

const json = (o) => { if (o && o.data) brand(o.data); return new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }); };
const reply = (content, ephemeral = true, extra = {}) => json({ type: 4, data: { content, flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: { parse: [] }, ...extra } });

export async function handleInteraction(request, env, ctx) {
  const body = await verifyRequest(request, env.DISCORD_PUBLIC_KEY);
  if (body === null) return new Response('Bad signature', { status: 401 });
  const i = JSON.parse(body);
  if (i.type === 1) return json({ type: 1 });

  const user = i.member?.user || i.user;
  const actor = { id: user.id, name: displayName(user) };
  const roles = i.member?.roles || [];
  const perms = i.member?.permissions || '0';

  try {
    // ---------- autocomplete ----------
    if (i.type === 4) {
      const types = await listTypes(env, i.guild_id);
      const focused = findFocused(i.data.options);
      const q = String(focused?.value || '').toLowerCase();
      const onlyOpen = i.data.name === 'apply';
      return json({
        type: 8,
        data: { choices: types.filter((t) => (!onlyOpen || t.enabled) && t.name.toLowerCase().includes(q)).slice(0, 25).map((t) => ({ name: trunc(`${t.name}${t.enabled ? '' : ' (closed)'}`, 100), value: t.id })) },
      });
    }

    // ---------- slash commands ----------
    if (i.type === 2) {
      const name = i.data.name;
      const opts = Object.fromEntries((i.data.options || []).map((o) => [o.name, o.value]));

      if (name === 'dashboard') return reply(`🖥️ Dashboard: ${env.BASE_URL}/dashboard?guild=${i.guild_id}`);

      if (name === 'setup') {
        const cfg = await getConfig(env, i.guild_id);
        cfg.approver_roles = [opts.approver_role];
        cfg.staff_roles = [opts.staff_role];
        if (opts.review_channel) cfg.review_channel_id = opts.review_channel;
        if (opts.webhook_url) {
          if (!/^https:\/\/(ptb\.|canary\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+/.test(opts.webhook_url)) return reply('❌ That is not a valid Discord webhook URL.');
          cfg.webhook_url = opts.webhook_url;
        }
        if (opts.cooldown_hours !== undefined) cfg.cooldown_hours = opts.cooldown_hours;
        await saveConfig(env, i.guild_id, cfg);
        await addLog(env, { guild_id: i.guild_id, action: 'config', actor_id: actor.id, actor_name: actor.name, detail: 'Updated via /setup' });
        if (cfg.review_channel_id) ctx.waitUntil(backfillReview(env, i.guild_id));
        return reply(
          `✅ **Setup saved**\n• Approver role: <@&${opts.approver_role}>\n• Staff (reset) role: <@&${opts.staff_role}>\n• Review channel: ${cfg.review_channel_id ? `<#${cfg.review_channel_id}>` : '*not set*'}\n• Webhook: ${cfg.webhook_url ? 'custom' : 'default'}\n• Reapply cooldown: **${cfg.cooldown_hours}h**\n\nNext: \`/application create\` → \`/application add-question\` → \`/panel\`\nOr use the dashboard: ${env.BASE_URL}/dashboard?guild=${i.guild_id}`
        );
      }

      if (name === 'application') {
        const sub = i.data.options[0];
        const so = Object.fromEntries((sub.options || []).map((o) => [o.name, o.value]));
        if (sub.name === 'create') {
          const r = await env.DB.prepare('INSERT INTO app_types (guild_id, name, description, questions, enabled, accept_role_id, remove_role_id, button_style, created_at) VALUES (?,?,?,?,1,?,?,1,?)')
            .bind(i.guild_id, so.name, so.description || '', '[]', so.accept_role || null, so.remove_role || null, now()).run();
          return reply(`✅ Created **${so.name}** (ID ${r.meta.last_row_id}). Add questions with \`/application add-question\`.`);
        }
        if (sub.name === 'list') {
          const types = await listTypes(env, i.guild_id);
          if (!types.length) return reply('No applications yet. Create one with `/application create`.');
          const text = types.map((t) => `**${t.name}** (ID ${t.id}) — ${t.enabled ? '🟢 open' : '🔴 closed'}\n${t.questions.map((q, n) => `  ${n + 1}. ${trunc(q, 120)}`).join('\n') || '  *no questions*'}`).join('\n\n');
          return reply(trunc(text, 1950));
        }
        const type = await getType(env, so.application);
        if (!type || type.guild_id !== i.guild_id) return reply('❌ Application not found.');
        if (sub.name === 'add-question') {
          type.questions.push(so.question);
          await env.DB.prepare('UPDATE app_types SET questions=? WHERE id=?').bind(JSON.stringify(type.questions), type.id).run();
          return reply(`✅ Added question ${type.questions.length} to **${type.name}**.`);
        }
        if (sub.name === 'remove-question') {
          if (so.number > type.questions.length) return reply('❌ No question with that number.');
          const [removed] = type.questions.splice(so.number - 1, 1);
          await env.DB.prepare('UPDATE app_types SET questions=? WHERE id=?').bind(JSON.stringify(type.questions), type.id).run();
          return reply(`🗑️ Removed: "${trunc(removed, 200)}"`);
        }
        if (sub.name === 'toggle') {
          await env.DB.prepare('UPDATE app_types SET enabled=? WHERE id=?').bind(type.enabled ? 0 : 1, type.id).run();
          return reply(`**${type.name}** is now ${type.enabled ? '🔴 closed' : '🟢 open'}. Re-post or update panels to refresh buttons.`);
        }
      }

      if (name === 'panel') {
        const types = await listTypes(env, i.guild_id);
        if (!types.length) return reply('❌ Create an application first with `/application create`.');
        const r = await env.DB.prepare('INSERT INTO panels (guild_id, channel_id, title, description, color, app_type_ids, created_at) VALUES (?,?,?,?,?,?,?)')
          .bind(i.guild_id, opts.channel, opts.title || 'Applications', opts.description || 'Click a button below to apply. The questions will be sent to your DMs.', opts.color || '#5865F2', JSON.stringify(types.map((t) => t.id)), now()).run();
        const panel = await env.DB.prepare('SELECT * FROM panels WHERE id=?').bind(r.meta.last_row_id).first();
        ctx.waitUntil((async () => {
          try { await postPanel(env, panel); await editOriginal(env, i, { content: `✅ Panel posted in <#${opts.channel}>.` }); }
          catch (e) { await editOriginal(env, i, { content: `❌ Couldn't post the panel: ${trunc(e.message, 300)}\nMake sure I can view and send messages in that channel.` }); }
        })());
        return json({ type: 5, data: { flags: EPHEMERAL } });
      }

      if (name === 'apply') return deferredApply(i, env, ctx, user, opts.application);

      if (name === 'reset-application') {
        const cfg = await getConfig(env, i.guild_id);
        if (!canReset(cfg, roles, perms)) return reply('❌ You need the configured staff role to reset application status.');
        ctx.waitUntil((async () => {
          const r = await resetUser(env, i.guild_id, opts.user, actor);
          await editOriginal(env, i, { content: `🔄 Reset application status for <@${opts.user}> (${r.changed} application(s)). They can now apply again immediately.` });
        })());
        return json({ type: 5, data: { flags: EPHEMERAL } });
      }
      return reply('Unknown command.');
    }

    // ---------- components ----------
    if (i.type === 3) {
      const id = i.data.custom_id;

      if (id.startsWith('apply:')) return deferredApply(i, env, ctx, user, Number(id.split(':')[1]));

      // DM questionnaire controls
      if (id === 'app_correct') return json({ type: 4, data: await onCorrect(env, user.id) });
      if (id === 'app_correct_pick') return json({ type: 7, data: await onCorrectPick(env, user.id, Number(i.data.values[0])) });
      if (id === 'app_cancel') return json({ type: 7, data: await onCancel(env, user.id) });
      if (id === 'app_submit') {
        ctx.waitUntil((async () => {
          try { await editOriginal(env, i, await onSubmit(env, user)); }
          catch (e) { console.log('submit error', e.stack); await editOriginal(env, i, { content: '⚠️ Something went wrong submitting. Please try again.' }); }
        })());
        return json({ type: 6 });
      }

      // review controls
      if (id.startsWith('rv_')) {
        const [kind, appIdStr] = id.split(':');
        const appId = Number(appIdStr);
        const cfg = await getConfig(env, i.guild_id);
        if (!canApprove(cfg, roles, perms)) return reply('❌ You do not have an approver role for applications.');
        if (kind === 'rv_dn') return json({ type: 4, data: { flags: EPHEMERAL, content: `Select the reason for denying application **#${appId}**:`, components: denyReasonMenu(appId) } });
        if (kind === 'rv_ap' || kind === 'rv_dr') {
          ctx.waitUntil((async () => {
            const r = kind === 'rv_ap' ? await decide(env, appId, 'approved', null, actor) : await decide(env, appId, 'denied', i.data.values[0], actor);
            if (kind === 'rv_dr') await editOriginal(env, i, { content: r.ok ? `⛔ Application #${appId} denied — ${r.app.deny_reason}.` : `❌ ${r.error}`, components: [] });
            else if (!r.ok) await followup(env, i, { content: `❌ ${r.error}`, flags: EPHEMERAL });
          })());
          return json({ type: kind === 'rv_dr' ? 7 : 6, ...(kind === 'rv_dr' ? { data: { content: '⏳ Processing…', components: [] } } : {}) });
        }
      }
    }
  } catch (e) {
    console.log('interaction error', e.stack || e.message);
    return reply('⚠️ Something went wrong. Please try again.');
  }
  return reply('Unknown interaction.');
}

function deferredApply(i, env, ctx, user, typeId) {
  ctx.waitUntil((async () => {
    try {
      const r = await startApplication(env, i.guild_id, typeId, user, i.member?.roles);
      await editOriginal(env, i, { content: (r.ok ? '' : '❌ ') + r.reason });
    } catch (e) {
      console.log('apply error', e.stack);
      await editOriginal(env, i, { content: '⚠️ Something went wrong starting your application. Please try again.' });
    }
  })());
  return json({ type: 5, data: { flags: EPHEMERAL } });
}

function findFocused(opts) {
  for (const o of opts || []) {
    if (o.focused) return o;
    const f = findFocused(o.options);
    if (f) return f;
  }
  return null;
}

export async function registerCommands(env) {
  return dapi(env, 'PUT', `/applications/${env.DISCORD_CLIENT_ID}/commands`, COMMANDS);
}
