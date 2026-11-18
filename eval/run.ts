// Runs the extractor over the test set and scores every document against its answer key.
//   npx tsx eval/run.ts [--model claude-haiku-5-5] [--effort low] [--set tuning] [--only id,id] [--concurrency 3]
// The held-out documents (--set heldout or all) are kept out of tuning: they need --final, and each
// such run is logged in eval/heldout-log.md, so the published results are their first reading.
// Every call is billed. Results: eval/runs/<time>_<model>_<effort>_<set>.json
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { checkFile } from '../src/extract/files.ts';
import { extractDocument, type Effort, type ModelId } from '../src/extract/extract.ts';
import { scoreDocument, summarise, type Key, type RunRecord } from './score.ts';

const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: 'claude-haiku-5-5' },
    effort: { type: 'string', default: 'low' },
    set: { type: 'string', default: 'tuning' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
    final: { type: 'boolean', default: false },
  },
});
const model = args.model as ModelId;
const effort = args.effort as Effort;
const set = args.set as 'tuning' | 'heldout' | 'all';
if (set !== 'tuning' && !args.final) {
  console.error('The held-out documents are scored once, at the end. Add --final to run them.');
  process.exit(2);
}

process.loadEnvFile('.env');
const keys = new Map<string, Key>(
  readdirSync('samples/keys').map((f) => {
    const k: Key = JSON.parse(readFileSync(`samples/keys/${f}`, 'utf8'));
    return [k.id, k];
  }),
);
let chosen = [...keys.values()].filter((k) => set === 'all' || k.set === set);
if (args.only) {
  const ids = args.only.split(',');
  chosen = chosen.filter((k) => ids.includes(k.id));
}
if (!chosen.length) throw new Error('No documents selected.');

const client = new Anthropic();
const raw: Record<string, unknown> = {};
const records: RunRecord[] = [];

async function one(k: Key): Promise<RunRecord> {
  const checked = await checkFile(readFileSync(`samples/docs/${k.file}`));
  if (!checked.ok) throw new Error(`${k.id}: ${checked.message}`);
  try {
    const r = await extractDocument(client, checked.file, { model, effort });
    if (!r.ok) return { id: k.id, ok: false, reason: r.reason, costUsd: r.costUsd, ms: r.ms };
    raw[k.id] = r.data;
    return { id: k.id, ok: true, costUsd: r.costUsd, ms: r.ms, score: scoreDocument(k, r.data) };
  } catch (err) {
    return { id: k.id, ok: false, reason: err instanceof Error ? err.message : String(err), costUsd: 0, ms: 0 };
  }
}

const queue = [...chosen];
const width = Math.max(...chosen.map((k) => k.id.length));
console.log(`${chosen.length} documents, ${model} (effort ${effort}), set ${set}\n`);
await Promise.all(
  Array.from({ length: Math.min(Number(args.concurrency), queue.length) }, async () => {
    for (let k = queue.shift(); k; k = queue.shift()) {
      const r = await one(k);
      records.push(r);
      const sc = r.score;
      const line = sc
        ? `fields ${String(sc.fields.filter((f) => f.ok).length).padStart(2)}/14  lines ${sc.lines.correct}/${sc.lines.expected}  caught ${sc.flags.caught.length}/${sc.flags.expected.length}  false ${sc.flags.falseAlarms.length}`
        : `FAILED ${r.reason}`;
      console.log(`${k.id.padEnd(width)}  ${line}  $${r.costUsd.toFixed(4)}  ${(r.ms / 1000).toFixed(1)} s`);
    }
  }),
);
records.sort((a, b) => a.id.localeCompare(b.id));

// What went wrong, document by document.
for (const r of records) {
  const sc = r.score;
  if (!sc) continue;
  const issues = [
    ...sc.fields.filter((f) => !f.ok).map((f) => `${f.field}: want ${JSON.stringify(f.want)}, got ${JSON.stringify(f.got)}`),
    ...sc.lines.errors,
    ...sc.flags.missed.map((c) => `missed flag ${c}`),
    ...sc.flags.falseAlarms.map((c) => `false alarm ${c}`),
    ...(sc.injection.planted && !sc.injection.reported ? ['injection not reported'] : []),
  ];
  if (issues.length) console.log(`\n${r.id}\n  ${issues.join('\n  ')}`);
}

const s = summarise(records, keys);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
console.log(`
Fields correct        ${s.fieldsCorrect}/${s.fieldsTotal} (${pct(s.fieldsCorrect, s.fieldsTotal)})
Line items correct    ${s.linesCorrect}/${s.linesTotal} (${pct(s.linesCorrect, s.linesTotal)})
Documents all correct ${s.documentsAllCorrect}/${s.documents}
Problems caught       ${s.problemsCaught}/${s.problemsPlanted}
Clean docs, no alarm  ${s.cleanDocuments - s.cleanWithFalseAlarm}/${s.cleanDocuments}   (false alarms in total: ${s.falseAlarmsTotal})
Injection reported    ${s.injectionsReported}/${s.injectionsPlanted}   (suspicious text reported on other docs: ${s.spuriousSuspicious})
Failed calls          ${s.failures}
By source             ${Object.entries(s.byRender).map(([r, g]) => `${r} ${pct(g.fieldsCorrect + g.linesCorrect, g.fieldsTotal + g.linesTotal)} (${g.documents})`).join('   ')}
Cost                  $${s.costUsd.toFixed(3)} total, $${s.costPerDocument.toFixed(4)} per document
Median time           ${s.medianSeconds.toFixed(1)} s`);

mkdirSync('eval/runs', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = `eval/runs/${stamp}_${model}_${effort}_${set}${args.only ? '_partial' : ''}.json`;
writeFileSync(out, JSON.stringify({ meta: { model, effort, set, only: args.only ?? null, at: new Date().toISOString() }, summary: s, records, extractions: raw }, null, 2) + '\n');
console.log(`\nSaved ${out}`);
if (set !== 'tuning') {
  const log = 'eval/heldout-log.md';
  if (!existsSync(log)) writeFileSync(log, '# Held-out runs\n\nEvery run that included the held-out documents, in order. The first run per model is the published result.\n\n');
  appendFileSync(log, `- ${new Date().toISOString()}  ${model} (effort ${effort}), set ${set}${args.only ? ` (only ${args.only})` : ''}: fields ${pct(s.fieldsCorrect, s.fieldsTotal)}, lines ${pct(s.linesCorrect, s.linesTotal)}, problems ${s.problemsCaught}/${s.problemsPlanted}, $${s.costUsd.toFixed(3)} → ${out}\n`);
}
