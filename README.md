# Blueline Whitelist Applications

FiveM whitelist / department application bot for Discord, with a custom web dashboard. Runs 24/7 on Cloudflare Workers at **https://dmpforge.co.uk**.

## Features
- Apply buttons on panels (or `/apply`) → questions sent one by one to the applicant's **DMs**; each reply is the answer.
- At the end: **Submit / Correct / Cancel** buttons. Correct lets them pick a question and re-answer it.
- Submitted applications are posted to the webhook as an embed (username, avatar, every question with the answer underneath, in order) and optionally to a review channel with **Approve / Deny** buttons.
- Only configured **approver roles** can approve/deny. Denying requires a reason: *Lack of detail*, *Don't meet our minimum age requirements of 16+*, *Not enough past roleplay experience*.
- **48h reapply cooldown** (configurable). Members with the **staff role** can reset someone's status (`/reset-application` or dashboard) to bypass it.
- Dashboard (Discord login): every server the bot is in, settings, application/question builder, panel builder, Submitted / Approved / Denied lists, logs.

## Commands
`/setup` · `/application create|add-question|remove-question|toggle|list` · `/panel` · `/apply` · `/reset-application` · `/dashboard`

## Secrets (Cloudflare → Worker → Settings → Variables and Secrets)
| Name | Value |
|---|---|
| `DISCORD_TOKEN` | Bot token |
| `DISCORD_PUBLIC_KEY` | Application public key |
| `DISCORD_CLIENT_ID` | Application ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret |
| `DEFAULT_WEBHOOK_URL` | Webhook for submitted applications |

Discord Developer Portal: Interactions Endpoint URL = `https://dmpforge.co.uk/interactions`, OAuth2 redirect = `https://dmpforge.co.uk/callback`.

Database schema: `schema.sql` (`npm run db:init`). Gateway status: `https://dmpforge.co.uk/status`.
