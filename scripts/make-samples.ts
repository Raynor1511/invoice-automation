// Generates every sample document and its answer key from scripts/samples/data.ts:
//   samples/docs/<id>.pdf|jpg      the document
//   samples/keys/<id>.json         what a correct reading contains, and which flags must be raised
//   samples/index.json             the list, with the six demo samples marked
// Run: npm run samples   (deterministic: regenerating gives the same documents)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { amounts, docs, type Doc } from './samples/data.ts';
import { renderPdf } from './samples/render-pdf.ts';
import { renderImage } from './samples/render-image.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'samples', 'docs');
const keysDir = path.join(root, 'samples', 'keys');
mkdirSync(docsDir, { recursive: true });
mkdirSync(keysDir, { recursive: true });

/** The evaluation's fixed "today", so date checks give the same answer on every run. */
export const EVAL_TODAY = '2026-11-18';

function key(d: Doc, file: string) {
  const a = amounts(d);
  // Per-line VAT rates are scored only where the document prints them on each line.
  const lineVatPrinted = d.layout === 'classic';
  return {
    id: d.id,
    file,
    set: d.set,
    demo: d.demo ?? null,
    context: { today: EVAL_TODAY, ...(d.seen ? { seen: d.seen } : {}) },
    lineVatPrinted,
    expected: {
      document_type: d.type,
      supplier: { name: d.supplier.name, vat_number: d.supplier.vat },
      invoice_number: d.number,
      invoice_date: d.date,
      due_date: d.due,
      po_number: d.po,
      currency: d.currency,
      line_items: d.lines.map((l, i) => ({ description: l.description, quantity: l.qty, unit_price: l.unit, vat_rate: lineVatPrinted ? l.vat : null, line_total: a.lineTotals[i]! })),
      net_total: a.net,
      vat_total: a.vat,
      total: a.total,
      payment: { sort_code: d.bank?.sortCode ?? null, account_number: d.bank?.account ?? null, iban: d.iban ?? null },
      has_injection: Boolean(d.hidden),
    },
    expectFlags: d.expectFlags,
    allowFlags: d.allowFlags ?? [],
  };
}

const index: { id: string; file: string; set: string; demo: Doc['demo'] | null }[] = [];
for (const d of docs) {
  let bytes: Buffer;
  let ext: string;
  if (d.render === 'pdf') {
    bytes = await renderPdf(d);
    ext = 'pdf';
  } else {
    ({ bytes, ext } = await renderImage(d));
  }
  const file = `${d.id}.${ext}`;
  writeFileSync(path.join(docsDir, file), bytes);
  writeFileSync(path.join(keysDir, `${d.id}.json`), JSON.stringify(key(d, file), null, 2) + '\n');
  index.push({ id: d.id, file, set: d.set, demo: d.demo ?? null });
  console.log(`${d.set.padEnd(8)} ${file.padEnd(36)} ${(bytes.length / 1024).toFixed(0).padStart(5)} KB`);
}
writeFileSync(path.join(root, 'samples', 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`${docs.length} documents: ${docs.filter((d) => d.set === 'tuning').length} tuning, ${docs.filter((d) => d.set === 'heldout').length} held-out, ${docs.filter((d) => d.demo).length} demo samples.`);
