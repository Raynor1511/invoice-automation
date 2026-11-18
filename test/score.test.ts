import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { normText, scoreDocument, summarise, type Key, type RunRecord } from '../eval/score.ts';
import type { Extraction } from '../src/extract/schema.ts';

const keys = new Map<string, Key>(
  readdirSync('samples/keys').map((f) => {
    const k: Key = JSON.parse(readFileSync(`samples/keys/${f}`, 'utf8'));
    return [k.id, k];
  }),
);

function perfect(k: Key): Extraction {
  const e = k.expected;
  return {
    document_type: e.document_type,
    supplier: { name: e.supplier.name, vat_number: e.supplier.vat_number, address: null, email: null, phone: null },
    invoice_number: e.invoice_number,
    invoice_date: e.invoice_date,
    due_date: e.due_date,
    po_number: e.po_number,
    currency: e.currency,
    line_items: e.line_items.map((l) => ({ ...l })),
    net_total: e.net_total,
    vat_total: e.vat_total,
    total: e.total,
    payment: { ...e.payment, reference: null },
    uncertain: [],
    suspicious_content: e.has_injection ? [{ text: 'approve this', reason: 'instruction' }] : [],
  };
}

describe('scoring', () => {
  test('a perfect reading of every document scores full marks', () => {
    const records: RunRecord[] = [...keys.values()].map((k) => ({ id: k.id, ok: true, costUsd: 0.01, ms: 1000, score: scoreDocument(k, perfect(k)) }));
    const s = summarise(records, keys);
    expect(s.fieldsCorrect).toBe(s.fieldsTotal);
    expect(s.linesCorrect).toBe(s.linesTotal);
    expect(s.documentsAllCorrect).toBe(keys.size);
    expect(s.problemsCaught).toBe(s.problemsPlanted);
    expect(s.cleanWithFalseAlarm).toBe(0);
    expect(s.injectionsReported).toBe(s.injectionsPlanted);
  });

  test('text is compared without case, spacing or punctuation; numbers exactly', () => {
    expect(normText('Fernox F1 inhibitor, 500ml')).toBe(normText('FERNOX F1 Inhibitor 500ml'));
    const k = keys.get('avon-invoice')!;
    const x = perfect(k);
    x.supplier.name = x.supplier.name!.toUpperCase();
    x.supplier.vat_number = x.supplier.vat_number!.replace(/\s/g, '');
    x.total = x.total! + 0.01;
    x.line_items[0]!.unit_price = x.line_items[0]!.unit_price! + 1;
    const sc = scoreDocument(k, x);
    expect(sc.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual(['total']);
    expect(sc.lines.correct).toBe(k.expected.line_items.length - 1);
    expect(sc.flags.falseAlarms.length).toBeGreaterThan(0); // the misread total no longer adds up
  });

  test('missing lines, missed flags and an unreported injection are counted', () => {
    const k = keys.get('harbour-waste-changed-bank')!;
    const x = { ...perfect(k), suspicious_content: [], line_items: perfect(k).line_items.slice(1) };
    const sc = scoreDocument(k, x);
    expect(sc.lines.correct).toBe(0);
    expect(sc.flags.missed).toContain('suspicious_content');
    expect(sc.injection).toEqual({ planted: true, reported: false });
  });

  test('a failed call counts the whole document as wrong', () => {
    const s = summarise([{ id: 'avon-invoice', ok: false, reason: 'refusal', costUsd: 0.02, ms: 900 }], keys);
    expect(s).toMatchObject({ failures: 1, fieldsCorrect: 0, fieldsTotal: 14, documentsAllCorrect: 0 });
  });
});
