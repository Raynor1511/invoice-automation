// The workflow's logic, as plain functions (tested in test/n8n.test.ts). n8n/build.mjs inlines this
// file and ledger.mjs into the Code nodes (import lines and `export` are stripped), so: no Node
// modules, nothing but plain JS.
import { STATUS } from './ledger.mjs';

const ROW_ID_RE = /^INV-[0-9]{6}-[A-Z0-9]{4}$/;

/** "2026-11-19 10:32:05" in London time: Google Sheets reads it as a date and time (UK locale). */
export function londonStamp(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** A row id such as INV-261119-7KQ2. `random` returns a number in [0, 1). */
export function newRowId(date, random) {
  const d = londonStamp(date);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let tail = '';
  for (let i = 0; i < 4; i++) tail += chars[Math.floor(random() * chars.length)];
  return `INV-${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${tail}`;
}

/** Invoice numbers this demo session has already recorded, per supplier id (for the duplicate check). */
export function seenForSession(rows, session) {
  const seen = {};
  for (const r of rows) {
    if (r.session !== session || !r.supplierId || !r.number) continue;
    (seen[r.supplierId] ??= []).push(String(r.number));
  }
  return seen;
}

/** The ledger row for a reading. Any flag means a person looks at it before it is paid. */
export function ledgerRow({ id, extract, session, sampleTitle, now }) {
  const x = extract.reading;
  const flags = extract.flags ?? [];
  return {
    id,
    added: londonStamp(now),
    supplier: x.supplier?.name ?? '',
    onFile: extract.supplier ? 'Yes' : 'No',
    number: x.invoice_number ?? '',
    date: x.invoice_date ?? '',
    due: x.due_date ?? '',
    po: x.po_number ?? '',
    currency: x.currency ?? '',
    net: x.net_total ?? '',
    vat: x.vat_total ?? '',
    total: x.total ?? '',
    checks: flags.length ? flags.map((f) => `${f.severity === 'error' ? 'Check' : 'Note'}: ${f.message}`).join('\n') : 'All checks passed',
    status: flags.length ? STATUS.review : STATUS.ready,
    decidedBy: '',
    decidedAt: '',
    source: `Sample: ${sampleTitle}`,
    session,
    supplierId: extract.supplier?.id ?? '',
    slack: '',
  };
}

function money(v, currency) {
  if (v === '' || v === null || v === undefined) return '—';
  const n = Number(v);
  const sym = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '';
  return `${sym}${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${sym ? '' : ` ${currency}`}`;
}

/** Slack's mrkdwn treats &, < and > specially; document text must not become links or mentions. */
export function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cardTop(row) {
  return [
    { type: 'header', text: { type: 'plain_text', text: `Invoice to check: ${row.supplier || 'unknown supplier'}`.slice(0, 150) } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Invoice*\n${slackEscape(row.number || '—')}` },
        { type: 'mrkdwn', text: `*Total*\n${money(row.total, row.currency)}` },
        { type: 'mrkdwn', text: `*Date*\n${slackEscape(row.date || '—')}` },
        { type: 'mrkdwn', text: `*Due*\n${slackEscape(row.due || '—')}` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: slackEscape(row.checks).split('\n').map((l) => `• ${l}`).join('\n').slice(0, 2900) } },
  ];
}

/** The approval card posted to #invoices for a flagged invoice. */
export function approvalCard(row, sheetUrl) {
  const value = JSON.stringify({ row: row.id });
  return {
    text: slackEscape(`Invoice to check: ${row.supplier} ${row.number}`),
    blocks: [
      ...cardTop(row),
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'approve', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value },
          { type: 'button', action_id: 'reject', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Ledger row ${row.id} · <${sheetUrl}|Open the purchase ledger>` }] },
    ],
  };
}

/** The same card once decided: the buttons are replaced by who decided and when. */
export function decidedCard(row, sheetUrl) {
  const mark = row.status === STATUS.approved ? ':white_check_mark:' : ':x:';
  return {
    text: slackEscape(`${row.status}: ${row.supplier} ${row.number}`),
    blocks: [
      ...cardTop(row),
      { type: 'section', text: { type: 'mrkdwn', text: `${mark} *${row.status}* by ${slackEscape(row.decidedBy)} on ${row.decidedAt}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Ledger row ${row.id} · <${sheetUrl}|Open the purchase ledger>` }] },
    ],
  };
}

/**
 * Applies an Approve/Reject decision to the ledger rows. Page decisions may only touch rows from the
 * visitor's own session; Slack decisions may touch any row. Only rows that need review can be decided.
 */
export function applyDecision(rows, d, now) {
  if (!d || !ROW_ID_RE.test(String(d.row)) || (d.action !== 'approve' && d.action !== 'reject')) return { ok: false, reason: 'invalid' };
  const row = rows.find((r) => r.id === d.row);
  if (!row) return { ok: false, reason: 'not_found' };
  if (d.source === 'page' && row.session !== d.session) return { ok: false, reason: 'not_found' };
  if (row.status !== STATUS.review) return { ok: false, reason: 'already_decided', row };
  // The ledger is public in the demo, so a Slack decision never records the person's Slack name.
  const decidedBy = d.source === 'slack' ? 'A manager (Slack)' : String(d.by || 'Someone').slice(0, 80);
  const updated = { ...row, status: d.action === 'approve' ? STATUS.approved : STATUS.rejected, decidedBy, decidedAt: londonStamp(now) };
  return { ok: true, row: updated };
}

/** Rows added more than `days` days ago (sheet row numbers, largest first so deleting keeps the rest in place). */
export function expiredRows(rows, now, days = 7) {
  const cutoff = londonStamp(new Date(now.getTime() - days * 86400000));
  return rows.filter((r) => r.added && String(r.added) < cutoff).map((r) => r.rowNumber).sort((a, b) => b - a);
}

/** The Monday summary for #invoices: the last seven days by supplier, and what still waits for approval. */
export function weeklySummary(rows, now, sheetUrl) {
  const since = londonStamp(new Date(now.getTime() - 7 * 86400000));
  const week = rows.filter((r) => String(r.added) >= since);
  const waiting = rows.filter((r) => r.status === STATUS.review);
  const bySupplier = {};
  for (const r of week) {
    if (r.currency !== 'GBP' || r.total === '') continue;
    bySupplier[r.supplier] = (bySupplier[r.supplier] ?? 0) + Number(r.total);
  }
  const lines = Object.entries(bySupplier)
    .sort((a, b) => b[1] - a[1])
    .map(([s, t]) => `• ${slackEscape(s)}: ${money(t, 'GBP')}`);
  const counts = { ready: week.filter((r) => r.status === STATUS.ready).length, approved: week.filter((r) => r.status === STATUS.approved).length, rejected: week.filter((r) => r.status === STATUS.rejected).length };
  return {
    text: `Supplier invoices this week: ${week.length}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Supplier invoices: the last 7 days' } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: week.length
            ? `*${week.length}* invoices recorded: ${counts.ready} passed every check, ${counts.approved} approved after a check, ${counts.rejected} rejected.\n*${waiting.length}* waiting for approval.`
            : `No invoices recorded this week. *${waiting.length}* waiting for approval.`,
        },
      },
      ...(lines.length ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Totals by supplier (GBP)*\n${lines.join('\n')}` } }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `<${sheetUrl}|Open the purchase ledger>` }] },
    ],
  };
}
