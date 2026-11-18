// Starts the demo service. Run: node src/server/main.ts   (Node 24 runs the TypeScript directly)
// Settings come from the environment (or .env locally); secrets are checked for presence, never printed.
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, extractDocument, type ModelId } from '../extract/extract.ts';
import { createApp, loadStatic, type Sample, type SavedReading } from './app.ts';
import { DEFAULT_LIMITS, Guard } from './guard.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const env = process.env;
const production = env.NODE_ENV === 'production';

function required(name: string): string {
  const v = env[name];
  if (!v) {
    console.error(`Missing setting ${name}.`);
    process.exit(1);
  }
  return v;
}

const apiKey = required('ANTHROPIC_API_KEY');
const origin = env.PUBLIC_ORIGIN ?? (production ? required('PUBLIC_ORIGIN') : 'http://localhost:8080');
const turnstile = env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY ? { siteKey: env.TURNSTILE_SITE_KEY, secret: env.TURNSTILE_SECRET, hostname: env.TURNSTILE_HOSTNAME } : null;
if (production && !turnstile) {
  console.error('Missing setting TURNSTILE_SITE_KEY / TURNSTILE_SECRET (required in production).');
  process.exit(1);
}
const model = (env.MODEL as ModelId | undefined) ?? DEFAULT_MODEL;
const dailySpendUsd = Number(env.DAILY_SPEND_USD ?? DEFAULT_LIMITS.dailySpendUsd);

const index: { id: string; file: string; demo: { order: number; title: string; blurb: string } | null }[] = JSON.parse(readFileSync(path.join(root, 'samples', 'index.json'), 'utf8'));
const samples: Sample[] = index.filter((s) => s.demo).map((s) => ({ id: s.id, file: s.file, ...s.demo! }));
const readingsDir = path.join(root, 'samples', 'readings');
const readings = new Map<string, SavedReading>(
  existsSync(readingsDir) ? readdirSync(readingsDir).map((f) => [path.basename(f, '.json'), JSON.parse(readFileSync(path.join(readingsDir, f), 'utf8')) as SavedReading]) : [],
);
const webDir = path.join(root, 'dist', 'web');

const client = new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 });
const app = createApp({
  origin,
  extract: (file) => extractDocument(client, file, { model, effort: 'low', signal: AbortSignal.timeout(100_000) }),
  samples,
  sampleDir: path.join(root, 'samples', 'docs'),
  readings,
  staticFiles: existsSync(webDir) ? loadStatic(webDir) : new Map(),
  turnstile,
  guard: new Guard({ ...DEFAULT_LIMITS, dailySpendUsd }),
  trustProxy: production,
  log: (e) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e })),
});

const port = Number(env.PORT ?? 8080);
const server = createServer(app);
server.requestTimeout = 120_000;
server.headersTimeout = 20_000;
server.listen(port, () => console.log(`Invoice demo on ${origin} (port ${port}); model ${model}; Turnstile ${turnstile ? 'on' : 'off'}; ${samples.length} samples, ${readings.size} saved readings; daily cap $${dailySpendUsd}.`));
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
