// Copies the demo samples' readings from a saved evaluation run into samples/readings/, so the page
// can still show the samples when live readings are paused (daily cap, per-visitor limit, API down).
// No API calls. Run: npx tsx scripts/save-readings.ts eval/runs/<run>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('Usage: npx tsx scripts/save-readings.ts eval/runs/<run>.json');
const run = JSON.parse(readFileSync(file, 'utf8'));
const index: { id: string; demo: unknown }[] = JSON.parse(readFileSync('samples/index.json', 'utf8'));
mkdirSync('samples/readings', { recursive: true });
for (const { id } of index.filter((s) => s.demo)) {
  const rec = run.records.find((r: { id: string }) => r.id === id);
  const extraction = run.extractions[id];
  if (!rec?.ok || !extraction) throw new Error(`${id}: no successful reading in ${file}`);
  writeFileSync(`samples/readings/${id}.json`, JSON.stringify({ model: run.meta.model, extraction, costUsd: rec.costUsd, ms: rec.ms }, null, 2) + '\n');
  console.log(`${id}  ${run.meta.model}  $${rec.costUsd.toFixed(4)}`);
}
