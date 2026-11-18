// Creates (or with --update, replaces) the three n8n credentials the workflows use, through the n8n
// API. Each is limited to the one host it is for. Prints names only, never values.
//   node n8n/credentials.mjs --env .env --env <n8n file> [--update]
// Needs: N8N_URL, N8N_API_KEY, GOOGLE_SERVICE_ACCOUNT_KEY_FILE, SLACK_BOT_TOKEN, INTERNAL_KEY, DEMO_INTERNAL_URL.
import { readFileSync } from 'node:fs';
import { CRED } from './build.mjs';
import { listAll, loadEnv, n8nApi } from './env.mjs';

const env = loadEnv();
const api = n8nApi(env);
const update = process.argv.includes('--update');
for (const k of ['GOOGLE_SERVICE_ACCOUNT_KEY_FILE', 'SLACK_BOT_TOKEN', 'INTERNAL_KEY', 'DEMO_INTERNAL_URL']) if (!env[k]) throw new Error(`Missing ${k}`);
const key = JSON.parse(readFileSync(env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, 'utf8'));
const internalHost = new URL(env.DEMO_INTERNAL_URL).hostname;

const wanted = [
  {
    name: CRED.google,
    type: 'googleApi',
    data: {
      email: key.client_email, privateKey: key.private_key, region: 'eu', inpersonate: false, delegatedEmail: '',
      httpNode: true, scopes: 'https://www.googleapis.com/auth/spreadsheets',
      allowedHttpRequestDomains: 'domains', allowedDomains: 'sheets.googleapis.com',
    },
  },
  { name: CRED.slack, type: 'slackApi', data: { accessToken: env.SLACK_BOT_TOKEN, allowedHttpRequestDomains: 'domains', allowedDomains: 'slack.com' } },
  { name: CRED.internal, type: 'httpHeaderAuth', data: { name: 'X-Internal-Key', value: env.INTERNAL_KEY, allowedHttpRequestDomains: 'domains', allowedDomains: internalHost } },
];

const existing = await listAll(api, '/credentials');
for (const c of wanted) {
  const found = existing.find((e) => e.name === c.name);
  if (found && !update) {
    console.log(`kept     ${c.name}`);
    continue;
  }
  // The public API can't edit a credential's secret fields in place, so --update deletes and recreates;
  // the workflows find credentials by name at deploy time, so redeploy them afterwards.
  if (found) await api('DELETE', `/credentials/${found.id}`);
  const made = await api('POST', '/credentials', c);
  console.log(`${found ? 'replaced' : 'created '} ${c.name} (${c.type}) ${made.id}`);
}
