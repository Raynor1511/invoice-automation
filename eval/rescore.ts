// Re-scores a saved run against the current answer keys, without calling the API. Used when an
// answer key is found to be wrong: the model's original reading is kept, only the marking changes.
//   npx tsx eval/rescore.ts eval/runs/<file>.json [--write]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { Extraction } from '../src/extract/schema.ts';
import { scoreDocument, summarise, type Key, type RunRecord } from './score.ts';

const file = process.argv[2];
if (!file) throw new Error('Usage: npx tsx eval/rescore.ts eval/runs/<file>.json [--write]');
const run = JSON.parse(readFileSync(file, 'utf8')) as { meta: Record<string, unknown>; summary: unknown; records: RunRecord[]; extractions: Record<string, Extraction> };
const keys = new Map<string, Key>(
  readdirSync('samples/keys').map((f) => {
    const k: Key = JSON.parse(readFileSync(`samples/keys/${f}`, 'utf8'));
    return [k.id, k];
  }),
);
const records = run.records.map((r) => {
  const x = run.extractions[r.id];
  return r.ok && x ? { ...r, score: scoreDocument(keys.get(r.id)!, x) } : r;
});
const before = run.summary as ReturnType<typeof summarise>;
const after = summarise(records, keys);
console.log(`${file}\n  fields ${before.fieldsCorrect}/${before.fieldsTotal} -> ${after.fieldsCorrect}/${after.fieldsTotal}, documents all correct ${before.documentsAllCorrect} -> ${after.documentsAllCorrect}, problems ${after.problemsCaught}/${after.problemsPlanted}, false alarms ${after.falseAlarmsTotal}`);
if (process.argv.includes('--write')) {
  writeFileSync(file, JSON.stringify({ ...run, records, summary: after, rescored: { at: new Date().toISOString(), previousSummary: before } }, null, 2) + '\n');
}
