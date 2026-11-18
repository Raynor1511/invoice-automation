// Checks run in code on what Claude extracted. The model reads; arithmetic, dates and the supplier
// records are checked here, so a confident-looking extraction can't hide a wrong total or changed bank
// details. Each failed check is a flag a person sees, with a plain-English reason.
import type { Extraction } from './schema.ts';
import { findSupplier, type Supplier } from '../data/suppliers.ts';

export type Severity = 'error' | 'warning';
export type Flag = { code: FlagCode; severity: Severity; field: string; message: string };
export type FlagCode =
  | 'missing_field'
  | 'line_math'
  | 'lines_vs_net'
  | 'vat_rate'
  | 'vat_amount'
  | 'net_vat_total'
  | 'invalid_date'
  | 'due_before_issue'
  | 'future_date'
  | 'old_date'
  | 'foreign_currency'
  | 'unknown_supplier'
  | 'vat_number_format'
  | 'vat_number_mismatch'
  | 'bank_details_changed'
  | 'duplicate'
  | 'uncertain_reading'
  | 'suspicious_content';

export type CheckContext = {
  /** Today's date (YYYY-MM-DD); fixed in tests and evaluation. */
  today: string;
  /** Invoice numbers already recorded for each supplier id (the n8n ledger passes these). */
  seen?: Record<string, string[]>;
};

export type CheckResult = { flags: Flag[]; supplier: Supplier | null; computed: { linesNet: number | null; vat: number | null } };

const UK_VAT_RATES = [0, 5, 20];
const PENNY = 0.011; // rounding tolerance for one amount
const money = (n: number) => n.toFixed(2);
const round2 = (n: number) => Math.round(n * 100) / 100;
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

function parseIsoDate(s: string | null): Date | null | 'invalid' {
  if (s == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return 'invalid';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : 'invalid';
}
const DAY = 86_400_000;
/** Shortens a quote at a word boundary, so a message never ends mid-word. */
export function clip(s: string, max = 140): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

export function checkExtraction(x: Extraction, ctx: CheckContext): CheckResult {
  const flags: Flag[] = [];
  const add = (code: FlagCode, severity: Severity, field: string, message: string) => flags.push({ code, severity, field, message });
  const isInvoiceLike = x.document_type === 'invoice' || x.document_type === 'credit_note';

  // Required fields
  if (!x.supplier.name) add('missing_field', 'error', 'supplier.name', 'No supplier name was found.');
  if (isInvoiceLike && !x.invoice_number) add('missing_field', 'error', 'invoice_number', 'No invoice number was found.');
  if (!x.invoice_date) add('missing_field', 'error', 'invoice_date', 'No document date was found.');
  if (x.total == null) add('missing_field', 'error', 'total', 'No total was found.');
  if (x.document_type === 'invoice' && !x.due_date) add('missing_field', 'warning', 'due_date', 'No due date: payment terms need checking.');

  // Line arithmetic
  x.line_items.forEach((l, i) => {
    if (l.quantity != null && l.unit_price != null && l.line_total != null) {
      const expected = round2(l.quantity * l.unit_price);
      if (Math.abs(expected - l.line_total) > PENNY)
        add('line_math', 'error', `line_items.${i}.line_total`, `Line ${i + 1}: ${l.quantity} × ${money(l.unit_price)} is ${money(expected)}, but the line says ${money(l.line_total)}.`);
    }
    if (l.vat_rate != null && !UK_VAT_RATES.includes(l.vat_rate) && x.currency === 'GBP')
      add('vat_rate', 'warning', `line_items.${i}.vat_rate`, `Line ${i + 1}: a VAT rate of ${l.vat_rate}% isn't a UK rate (20%, 5% or 0%).`);
  });

  const lineTotals = x.line_items.map((l) => l.line_total);
  const linesNet = x.line_items.length > 0 && lineTotals.every((t) => t != null) ? round2(lineTotals.reduce<number>((a, b) => a + (b ?? 0), 0)) : null;
  // Tolerance grows with the number of lines (each may be rounded).
  const linesTolerance = Math.max(PENNY, 0.005 * x.line_items.length + 0.006);
  // Receipts print amounts including VAT: lines adding up to the total (not the net) are fine.
  const linesAreGross = linesNet != null && x.total != null && x.net_total !== x.total && Math.abs(linesNet - x.total) <= linesTolerance;
  if (linesNet != null && x.net_total != null && !linesAreGross && Math.abs(linesNet - x.net_total) > linesTolerance)
    add('lines_vs_net', 'error', 'net_total', `The lines add up to ${money(linesNet)}, but the net total says ${money(x.net_total)}.`);

  // VAT amount: from per-line rates when every line has one, otherwise the overall rate must be a UK rate.
  let vat: number | null = null;
  const allRated = x.line_items.length > 0 && x.line_items.every((l) => l.vat_rate != null && l.line_total != null);
  if (allRated)
    vat = round2(
      x.line_items.reduce((a, l) => {
        const amount = l.line_total ?? 0;
        const rate = l.vat_rate ?? 0;
        return a + (linesAreGross ? (amount * rate) / (100 + rate) : (amount * rate) / 100);
      }, 0),
    );
  if (x.vat_total != null && x.currency === 'GBP') {
    if (vat != null) {
      if (Math.abs(vat - x.vat_total) > linesTolerance)
        add('vat_amount', 'error', 'vat_total', `VAT at the rates shown comes to ${money(vat)}, but the VAT total says ${money(x.vat_total)}.`);
    } else if (x.net_total != null && x.net_total !== 0) {
      const ratio = (x.vat_total / x.net_total) * 100;
      if (!UK_VAT_RATES.some((r) => Math.abs(ratio - r) < 0.15))
        add('vat_amount', 'warning', 'vat_total', `VAT is ${ratio.toFixed(1)}% of the net amount, which isn't a single UK rate. It may be a mix of rates: worth a check.`);
    }
  }

  if (x.net_total != null && x.vat_total != null && x.total != null && Math.abs(x.net_total + x.vat_total - x.total) > PENNY)
    add('net_vat_total', 'error', 'total', `Net ${money(x.net_total)} + VAT ${money(x.vat_total)} is ${money(round2(x.net_total + x.vat_total))}, but the total says ${money(x.total)}.`);

  // Dates
  const issued = parseIsoDate(x.invoice_date);
  const due = parseIsoDate(x.due_date);
  const today = parseIsoDate(ctx.today);
  if (issued === 'invalid') add('invalid_date', 'error', 'invoice_date', `"${x.invoice_date}" isn't a valid date.`);
  if (due === 'invalid') add('invalid_date', 'error', 'due_date', `"${x.due_date}" isn't a valid date.`);
  if (issued instanceof Date && due instanceof Date && due < issued) add('due_before_issue', 'error', 'due_date', 'The due date is before the invoice date.');
  if (issued instanceof Date && today instanceof Date) {
    if (issued.getTime() > today.getTime() + DAY) add('future_date', 'warning', 'invoice_date', 'The document is dated in the future.');
    if (issued.getTime() < today.getTime() - 365 * DAY) add('old_date', 'warning', 'invoice_date', 'The document is more than a year old.');
  }

  if (x.currency && x.currency !== 'GBP') add('foreign_currency', 'warning', 'currency', `Amounts are in ${x.currency}: check the exchange rate before paying.`);

  // Supplier records
  const cleanVat = x.supplier.vat_number?.replace(/\s+/g, '').toUpperCase() ?? null;
  const ukVat = cleanVat != null && /^(GB)?(\d{9}|\d{12})$/.test(cleanVat);
  const printedVat = ukVat ? 'GB' + digits(cleanVat) : cleanVat;
  if (cleanVat && !ukVat && x.currency === 'GBP')
    add('vat_number_format', 'warning', 'supplier.vat_number', `"${x.supplier.vat_number}" doesn't look like a UK VAT number (GB + 9 digits).`);

  const supplier = findSupplier(x.supplier.name, printedVat);
  if (!supplier) {
    if (x.supplier.name) add('unknown_supplier', 'warning', 'supplier.name', `"${x.supplier.name}" isn't in the supplier list: a person should confirm it's genuine.`);
  } else {
    if (supplier.vatNumber && printedVat && supplier.vatNumber !== printedVat)
      add('vat_number_mismatch', 'error', 'supplier.vat_number', `The VAT number doesn't match ${supplier.name}'s records.`);
    const sc = digits(x.payment.sort_code);
    const acc = digits(x.payment.account_number);
    if (supplier.bank && (sc || acc) && (sc !== digits(supplier.bank.sortCode) || acc !== digits(supplier.bank.accountNumber)))
      add('bank_details_changed', 'error', 'payment', `The bank details differ from the ones on file for ${supplier.name}. Confirm by phone, using the number on file, before paying.`);
    if (!supplier.bank && (sc || acc))
      add('bank_details_changed', 'warning', 'payment', `${supplier.name} has no bank details on file: confirm these before paying.`);
    const seen = ctx.seen?.[supplier.id] ?? [];
    if (x.invoice_number && seen.some((n) => n.trim().toLowerCase() === x.invoice_number!.trim().toLowerCase()))
      add('duplicate', 'error', 'invoice_number', `Invoice ${x.invoice_number} from ${supplier.name} has already been recorded.`);
  }

  for (const u of x.uncertain) add('uncertain_reading', 'warning', u.field, `Hard to read: ${u.reason}`);
  for (const s of x.suspicious_content)
    add('suspicious_content', 'error', 'document', `The document contains text aimed at the reader or an AI, which was ignored: “${clip(s.text)}”.`);

  return { flags, supplier, computed: { linesNet, vat } };
}
