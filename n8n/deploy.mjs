// Deploys the built workflows to n8n through its API: creates or updates each by name, fills in the
// deployment settings and ids, and activates them (Alerts first: the others name it as their error
// workflow). Placeholders are filled in memory only; the committed JSON keeps them.
//   node n8n/build.mjs && node n8n/deploy.mjs --env .env --env <n8n file>
// Needs: N8N_URL, N8N_API_KEY and the __ENV__ settings below.
import { WORKFLOWS } from './build.mjs';
import { listAll, loadEnv, n8nApi } from './env.mjs';

const ENV_ALLOWED = ['SHEET_ID', 'SHEET_URL', 'SLACK_INVOICES_CHANNEL', 'SLACK_ALERTS_CHANNEL', 'DEMO_INTERNAL_URL', 'LEDGER_SHEET_GID'];
const env = loadEnv();
const api = n8nApi(env);

const creds = await listAll(api, '/credentials');
const flows = await listAll(api, '/workflows');
const ids = Object.fromEntries(flows.map((w) => [w.name, w.id]));

function fill(value) {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/__ENV__([A-Z_]+)/g, (_, k) => {
        if (!ENV_ALLOWED.includes(k) || env[k] === undefined) throw new Error(`Setting ${k} is missing or not allowed`);
        return JSON.stringify(env[k]).slice(1, -1);
      })
      .replace(/__CREDENTIAL__([^"]+)/g, (_, name) => {
        const c = creds.find((x) => x.name === name);
        if (!c) throw new Error(`Credential "${name}" doesn't exist yet (run n8n/credentials.mjs)`);
        return c.id;
      })
      .replace(/__WORKFLOW__([^"]+)/g, (_, name) => {
        if (!ids[name]) throw new Error(`Workflow "${name}" must be deployed first`);
        return ids[name];
      }),
  );
}

for (const wf of WORKFLOWS) {
  const body = fill({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  let id = ids[wf.name];
  if (id) {
    await api('POST', `/workflows/${id}/deactivate`).catch(() => {});
    await api('PUT', `/workflows/${id}`, body);
  } else {
    id = (await api('POST', '/workflows', body)).id;
    ids[wf.name] = id;
  }
  // Every workflow is activated (published), Alerts included: n8n 2.x only runs a published error workflow.
  await api('POST', `/workflows/${id}/activate`);
  console.log(`active ${wf.name} (${id})`);
}
