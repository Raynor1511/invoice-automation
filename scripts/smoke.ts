// One real extraction of one sample, compared with its answer key: a quick check that the API call,
// the schema and the checks work together before running the full evaluation.
// Run: npx tsx scripts/smoke.ts [sample-id] [model] [effort]     (costs a few cents; needs .env)
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { checkFile } from '../src/extract/files.ts';
import { DEFAULT_MODEL, extractDocument, type Effort, type ModelId } from '../src/extract/extract.ts';
import { checkExtraction } from '../src/extract/checks.ts';

process.loadEnvFile('.env');
const id = process.argv[2] ?? 'harbour-waste-changed-bank';
const model = (process.argv[3] ?? DEFAULT_MODEL) as ModelId;
const effort = (process.argv[4] ?? 'low') as Effort;

const key = JSON.parse(readFileSync(`samples/keys/${id}.json`, 'utf8'));
const checked = await checkFile(readFileSync(`samples/docs/${key.file}`));
if (!checked.ok) throw new Error(checked.message);

const r = await extractDocument(new Anthropic(), checked.file, { model, effort });
console.log(`${id}  ${model} (${effort})  ${(r.ms / 1000).toFixed(1)} s  $${r.costUsd.toFixed(4)}  tokens in ${r.usage.input} / out ${r.usage.output}`);
if (!r.ok) {
  console.log(`FAILED: ${r.reason}`);
  process.exit(1);
}

const e = key.expected;
const x = r.data;
const rows: [string, unknown, unknown][] = [
  ['document_type', e.document_type, x.document_type],
  ['supplier.name', e.supplier.name, x.supplier.name],
  ['supplier.vat_number', e.supplier.vat_number, x.supplier.vat_number],
  ['invoice_number', e.invoice_number, x.invoice_number],
  ['invoice_date', e.invoice_date, x.invoice_date],
  ['due_date', e.due_date, x.due_date],
  ['po_number', e.po_number, x.po_number],
  ['currency', e.currency, x.currency],
  ['net_total', e.net_total, x.net_total],
  ['vat_total', e.vat_total, x.vat_total],
  ['total', e.total, x.total],
  ['payment.sort_code', e.payment.sort_code, x.payment.sort_code],
  ['payment.account_number', e.payment.account_number, x.payment.account_number],
  ['payment.iban', e.payment.iban, x.payment.iban],
  ['line_items (count)', e.line_items.length, x.line_items.length],
];
for (const [field, want, got] of rows) console.log(`${JSON.stringify(want) === JSON.stringify(got) ? '  ok ' : ' DIFF'} ${field.padEnd(24)} key ${JSON.stringify(want)}  got ${JSON.stringify(got)}`);
console.log(`\nuncertain: ${JSON.stringify(x.uncertain)}`);
console.log(`suspicious_content: ${JSON.stringify(x.suspicious_content)}  (key has injection: ${e.has_injection})`);

const flags = checkExtraction(x, key.context).flags;
const got = new Set<string>(flags.map((f) => f.code));
console.log(`\nflags expected: ${key.expectFlags.join(', ') || '(none)'}`);
for (const f of flags) console.log(`  ${f.severity.padEnd(7)} ${f.code.padEnd(22)} ${f.message}`);
const missed = key.expectFlags.filter((c: string) => !got.has(c));
const extra = [...got].filter((c) => !key.expectFlags.includes(c) && !key.allowFlags.includes(c));
console.log(`missed: ${missed.join(', ') || 'none'}   unexpected: ${extra.join(', ') || 'none'}`);
