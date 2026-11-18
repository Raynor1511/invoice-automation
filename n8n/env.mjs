// Settings for the n8n scripts, merged from KEY=value files given with --env (later files win).
// Values are never printed.
import { readFileSync } from 'node:fs';

export function loadEnv(argv = process.argv.slice(2)) {
  const env = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--env') continue;
    for (const line of readFileSync(argv[++i], 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

export function n8nApi(env) {
  if (!env.N8N_URL || !env.N8N_API_KEY) throw new Error('N8N_URL and N8N_API_KEY are needed (pass --env files).');
  return async (method, path, body) => {
    const res = await fetch(`${env.N8N_URL}/api/v1${path}`, {
      method,
      headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json?.message ?? text.slice(0, 200)}`);
    return json;
  };
}

/** Every item of a paginated list endpoint. */
export async function listAll(api, path) {
  const out = [];
  let cursor;
  do {
    const page = await api('GET', `${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    out.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}
