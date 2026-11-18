# Deploying

The demo runs on one VPS with Docker, behind a shared Caddy that terminates TLS (configured in a separate infrastructure repo). Two containers, from `compose.yml`:

| Container | Networks | Public? |
| --- | --- | --- |
| `invoice-demo` (page, API, Slack endpoint, internal API on 8081) | `web` (Caddy), `invoices-private` | `invoices.raynors.dev` → port 8080 only |
| `invoices-n8n` (the workflow) | `invoices-private` | No. The editor is on the server's 127.0.0.1:5679, reached through an SSH tunnel |

How requests flow:

```
visitor ─▶ Caddy ─▶ invoice-demo ──(private network, X-Internal-Key)──▶ n8n webhooks
Slack buttons ─▶ Caddy ─▶ invoice-demo /slack/interactions (signature checked) ──▶ n8n
n8n ──(private network, X-Internal-Key)──▶ invoice-demo:8081 /internal/extract
n8n ──▶ Google Sheets API, Slack API (credentials limited to those hosts)
```

## Settings (`.env` on the server, mode 600)

| Name | What |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | Cloudflare Turnstile widget for the site's hostname |
| `DAILY_SPEND_USD` | Daily cap on AI spending (default 1). Past it, samples use their saved readings |
| `INTERNAL_KEY` | 32+ random characters, shared by the demo service and n8n's "Internal key" credential |
| `SHEET_URL` | The ledger sheet's link (shown to visitors) |
| `SLACK_SIGNING_SECRET` | From the Slack app (Basic Information) |
| `N8N_ENCRYPTION_KEY` | Random. Must never change: n8n's stored credentials are encrypted with it |

## First deployment

1. `git clone` into `/srv/invoice-automation`, write `.env`, then `docker compose up -d --build`.
2. Open the n8n editor through the tunnel (`ssh -N -L 5679:127.0.0.1:5679 <server>`, then http://localhost:5679). Create the owner account, then **Settings → n8n API → Create an API key**.
3. From a machine with the repo, with the tunnel open, put these in a git-ignored settings file: `N8N_URL=http://localhost:5679` and `N8N_API_KEY`, plus `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, `SLACK_BOT_TOKEN`, `INTERNAL_KEY`, `DEMO_INTERNAL_URL=http://invoice-demo:8081`, `SHEET_ID`, `SHEET_URL`, `SLACK_INVOICES_CHANNEL`, `SLACK_ALERTS_CHANNEL` (channel ids) and `LEDGER_SHEET_GID` (the ledger tab's id, usually 0). Then run:
   ```
   node n8n/credentials.mjs --env <settings file>
   node n8n/build.mjs && node n8n/deploy.mjs --env <settings file>
   ```
4. Lay out the sheet once: `npx tsx scripts/setup-sheet.ts` (`SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` in `.env`). Share the sheet with the service account as an editor, and with "anyone with the link" as a viewer.
5. Slack app: create it from `deploy/slack-app-manifest.yml`, install it, and invite it to `#invoices` and `#alerts`.

## Updates

```
ssh <server> 'cd /srv/invoice-automation && git pull --ff-only && docker compose up -d --build'
node n8n/build.mjs && node n8n/deploy.mjs --env <settings file>     # if the workflows changed (tunnel open)
```

## Checks after a deploy

- `https://invoices.raynors.dev/api/health` returns `{"ok":true}`, and the page's config shows `inbox`.
- An unsigned POST to `/slack/interactions` gets 401. A POST to `/api/extract` from another origin gets 403.
- Port 5679 isn't reachable from outside the server, and `invoices.raynors.dev/webhook/...` returns 404 (n8n isn't routed).
- Send a sample to the inbox: a ledger row appears, and a flagged one posts a card to `#invoices`.
