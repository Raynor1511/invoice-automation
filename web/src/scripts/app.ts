// The demo page: pick a sample or upload a file, get the reading and the checks, export it.
// Everything a document says is untrusted, so the page builds text nodes only (never innerHTML).
import type { Extraction } from '../../../src/extract/schema.ts';
import type { Flag } from '../../../src/extract/checks.ts';
import { showDocument } from './preview.ts';
import { inboxSection } from './inbox.ts';

type Config = { turnstileSiteKey: string | null; live: boolean; limits: { maxMb: number; maxPages: number }; inbox: { sheetUrl: string } | null; samples: { id: string; file: string; title: string; url: string; mediaType: string }[] };
type Result = {
  ok: true;
  source: 'live' | 'saved';
  reading: Extraction;
  flags: Flag[];
  supplierOnFile: { id: string; name: string } | null;
  model: string;
  costUsd: number;
  seconds: number;
  notice?: string;
};
type Failure = { ok: false; error: string; message: string };

const MODEL_NAMES: Record<string, string> = { 'claude-haiku-5-5': 'Claude Haiku 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5' };
const TYPE_NAMES: Record<string, string> = { invoice: 'Invoice', credit_note: 'Credit note', receipt: 'Receipt', statement: 'Statement', other: 'Other document' };
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** Small element builder: strings become text nodes, so document text can never become markup. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | undefined> = {}, ...children: (Node | string | null | undefined | false)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const dash = '—';
const show = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? dash : String(v));
function money(v: number | null | undefined, currency: string) {
  if (v === null || v === undefined) return dash;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}
function date(v: string | null) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return show(v);
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCDate() === d ? dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : v;
}

// --- Turnstile ---------------------------------------------------------------------------------

type TurnstileApi = {
  render: (el: HTMLElement, o: Record<string, unknown>) => string;
  execute: (id: string) => void;
  reset: (id: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window { turnstile?: TurnstileApi }
}
let script: Promise<void> | null = null;
let widget: { id: string; host: HTMLElement } | null = null;
let pending: { resolve: (t: string) => void; reject: (e: Error) => void; prompt: HTMLElement; text: string; host: HTMLElement } | null = null;

function loadTurnstile(): Promise<void> {
  script ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      script = null;
      reject(new Error('turnstile'));
    };
    document.head.append(s);
  });
  return script;
}

/**
 * A Turnstile token. `host` is where the box appears if Cloudflare asks for a click (next to what the
 * visitor just pressed), and `prompt` is the line of text that asks them to tick it. A rendered widget
 * can't be moved (its iframe would reload), so it is re-rendered when the place changes.
 */
async function humanToken(cfg: Config, host: HTMLElement = $('#turnstile'), prompt: HTMLElement = $('#status')): Promise<string> {
  if (!cfg.turnstileSiteKey) return ''; // local development
  await loadTurnstile();
  const ts = window.turnstile!;
  if (widget && widget.host !== host) {
    ts.remove(widget.id);
    widget = null;
  }
  if (!widget) {
    const id = ts.render(host, {
      sitekey: cfg.turnstileSiteKey,
      execution: 'execute',
      appearance: 'interaction-only',
      callback: (t: string) => pending?.resolve(t),
      // Only when Cloudflare wants a click: say so, and bring the box into view.
      'before-interactive-callback': () => {
        if (!pending) return;
        pending.prompt.textContent = 'Please tick the box to confirm you are a person.';
        pending.host.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      },
      'after-interactive-callback': () => {
        if (pending) pending.prompt.textContent = pending.text;
      },
      'error-callback': () => pending?.reject(new Error('turnstile')),
    });
    widget = { id, host };
  }
  const token = new Promise<string>((resolve, reject) => (pending = { resolve, reject, prompt, text: prompt.textContent ?? '', host }));
  ts.execute(widget.id);
  try {
    return await token;
  } finally {
    pending = null;
    ts.reset(widget.id);
  }
}

// --- Rendering the result ----------------------------------------------------------------------

function flagClass(flags: Flag[], field: string): string | undefined {
  const mine = flags.filter((f) => f.field === field || f.field.startsWith(`${field}.`));
  if (!mine.length) return undefined;
  return mine.some((f) => f.severity === 'error') ? 'flag-error' : 'flag-warning';
}

function summary(flags: Flag[]) {
  const errors = flags.filter((f) => f.severity === 'error').length;
  const warnings = flags.length - errors;
  if (!flags.length) return h('div', { class: 'verdict ok' }, h('strong', {}, 'Nothing to check'), h('span', {}, 'The sums, VAT, dates and supplier details all agree. Ready to file.'));
  if (errors) return h('div', { class: 'verdict error' }, h('strong', {}, `${errors} ${errors === 1 ? 'problem' : 'problems'} to check before paying`), h('span', {}, warnings ? `Plus ${warnings} ${warnings === 1 ? 'note' : 'notes'}.` : 'Details below.'));
  return h('div', { class: 'verdict warning' }, h('strong', {}, `${warnings} ${warnings === 1 ? 'point' : 'points'} worth a look`), h('span', {}, 'Nothing stops this being filed.'));
}

function row(label: string, value: Node | string, cls?: string) {
  return h('div', { class: ['row', cls].filter(Boolean).join(' ') }, h('dt', {}, label), h('dd', {}, value));
}

function renderResult(r: Result) {
  const x = r.reading;
  const cur = x.currency || 'GBP';
  const out = $('#reading');
  const flagsList = r.flags.length
    ? h('ul', { class: 'flags' }, ...r.flags.map((f) => h('li', { class: f.severity }, h('span', { class: 'tag' }, f.severity === 'error' ? 'Check' : 'Note'), h('span', {}, f.message))))
    : null;

  const supplierBadge = r.supplierOnFile ? h('span', { class: 'badge ok' }, 'On file') : h('span', { class: 'badge warn' }, 'Not on file');
  const details = h(
    'dl',
    { class: 'details' },
    row('Supplier', h('span', {}, show(x.supplier.name), ' ', supplierBadge), flagClass(r.flags, 'supplier.name')),
    row('VAT number', show(x.supplier.vat_number), flagClass(r.flags, 'supplier.vat_number')),
    row('Document', TYPE_NAMES[x.document_type] ?? show(x.document_type)),
    row('Number', show(x.invoice_number), flagClass(r.flags, 'invoice_number')),
    row('Date', date(x.invoice_date), flagClass(r.flags, 'invoice_date')),
    row('Due', date(x.due_date), flagClass(r.flags, 'due_date')),
    row('Order ref.', show(x.po_number)),
    row('Currency', show(x.currency), flagClass(r.flags, 'currency')),
  );

  const lines = h(
    'table',
    { class: 'lines' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Description'), h('th', { scope: 'col', class: 'n' }, 'Qty'), h('th', { scope: 'col', class: 'n' }, 'Unit'), h('th', { scope: 'col', class: 'n' }, 'VAT'), h('th', { scope: 'col', class: 'n' }, 'Amount'))),
    h(
      'tbody',
      {},
      ...x.line_items.map((l, i) =>
        h(
          'tr',
          {},
          h('td', {}, show(l.description)),
          h('td', { class: 'n' }, show(l.quantity)),
          h('td', { class: 'n' }, l.unit_price === null ? dash : money(l.unit_price, cur)),
          h('td', { class: ['n', flagClass(r.flags, `line_items.${i}.vat_rate`)].filter(Boolean).join(' ') }, l.vat_rate === null ? dash : `${l.vat_rate}%`),
          h('td', { class: ['n', flagClass(r.flags, `line_items.${i}.line_total`)].filter(Boolean).join(' ') }, money(l.line_total, cur)),
        ),
      ),
    ),
  );

  const totals = h(
    'dl',
    { class: 'totals' },
    row('Net', money(x.net_total, cur), flagClass(r.flags, 'net_total')),
    row('VAT', money(x.vat_total, cur), flagClass(r.flags, 'vat_total')),
    row('Total', money(x.total, cur), ['grand', flagClass(r.flags, 'total')].filter(Boolean).join(' ')),
  );

  const p = x.payment;
  const payment = p.sort_code || p.account_number || p.iban
    ? h(
        'dl',
        { class: ['details', 'payment', flagClass(r.flags, 'payment')].filter(Boolean).join(' ') },
        p.sort_code ? row('Sort code', p.sort_code) : null,
        p.account_number ? row('Account no.', p.account_number) : null,
        p.iban ? row('IBAN', p.iban) : null,
        p.reference ? row('Reference', p.reference) : null,
      )
    : h('p', { class: 'muted' }, 'No bank details on the document.');

  const meta =
    r.source === 'live'
      ? `Read by ${MODEL_NAMES[r.model] ?? r.model} in ${r.seconds.toFixed(1)} s · AI cost $${r.costUsd.toFixed(4)}`
      : `Saved reading by ${MODEL_NAMES[r.model] ?? r.model} · AI cost when read: $${r.costUsd.toFixed(4)}`;

  out.replaceChildren(
    summary(r.flags),
    // The page-wide banner already says when live readings are paused for the day.
    r.notice && $('#paused').hidden ? h('p', { class: 'notice' }, r.notice) : '',
    flagsList ?? '',
    h('h3', {}, 'Details'),
    details,
    h('h3', {}, `Lines (${x.line_items.length})`),
    h('div', { class: 'table-scroll' }, lines),
    totals,
    h('h3', {}, 'Payment'),
    payment,
    h('p', { class: 'meta' }, meta),
  );
  $('#exports').hidden = false;
}

// --- Export ------------------------------------------------------------------------------------

function csv(r: Result): string {
  const x = r.reading;
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Quote everything; neutralise spreadsheet formulas in text taken from a document.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const head = ['supplier', 'supplier_vat_number', 'document_type', 'number', 'date', 'due_date', 'order_ref', 'currency', 'line', 'description', 'quantity', 'unit_price', 'vat_rate', 'line_total', 'net_total', 'vat_total', 'total', 'checks'];
  const checks = r.flags.map((f) => `${f.severity}: ${f.message}`).join(' | ');
  const lines = x.line_items.length ? x.line_items : [null];
  const rows = lines.map((l, i) => [x.supplier.name, x.supplier.vat_number, x.document_type, x.invoice_number, x.invoice_date, x.due_date, x.po_number, x.currency, l ? i + 1 : '', l?.description, l?.quantity, l?.unit_price, l?.vat_rate, l?.line_total, x.net_total, x.vat_total, x.total, checks]);
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

function download(name: string, type: string, body: string) {
  const a = h('a', { href: URL.createObjectURL(new Blob([body], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

// --- Running a reading -------------------------------------------------------------------------

let current: { result: Result; name: string } | null = null;
let generation = 0;
let busy = false;

function setBusy(on: boolean, label = '') {
  busy = on;
  document.querySelectorAll<HTMLButtonElement>('[data-sample], #upload-btn').forEach((b) => (b.disabled = on));
  $('#status').textContent = label;
  $('#status').hidden = !on;
  $('#result').setAttribute('aria-busy', String(on));
}

function showError(message: string) {
  $('#reading').replaceChildren(h('div', { class: 'verdict error' }, h('strong', {}, 'Not read'), h('span', {}, message)));
  $('#exports').hidden = true;
}

async function run(cfg: Config, name: string, bytes: ArrayBuffer, mediaType: string, request: (token: string) => Promise<Response>, sample: string | null = null) {
  if (busy) return;
  current = null;
  $('#result').hidden = false;
  $('#doc-name').textContent = name;
  $('#reading').replaceChildren();
  $('#exports').hidden = true;
  setBusy(true, 'Reading the document…');
  $('#result').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  const mine = ++generation;
  const preview = showDocument($('#pages'), bytes, mediaType, name, () => mine === generation).catch(() => {
    $('#pages').replaceChildren(h('p', { class: 'muted' }, 'The preview could not be shown, but the document can still be read.'));
    return 0;
  });
  try {
    // While live readings are paused, samples come from saved readings and need no check.
    const token = await (sample && !cfg.live ? Promise.resolve('') : humanToken(cfg)).catch(() => {
      throw new Error('The check that you are a person did not go through. Please reload the page and try again.');
    });
    const res = await request(token);
    const body = (await res.json().catch(() => ({ ok: false, message: 'The server sent an unexpected reply. Please try again.' }))) as Result | Failure;
    if (!body.ok) throw new Error(body.message);
    current = { result: body, name };
    setBusy(false);
    renderResult(body);
    // Samples can go on through the n8n workflow (uploads stay on this page: nothing is stored).
    if (sample && cfg.inbox) {
      $('#reading').append(
        inboxSection({
          sample,
          sheetUrl: cfg.inbox.sheetUrl,
          token: (host, prompt) => humanToken(cfg, host, prompt),
          onBusy: (on) => {
            busy = on;
            document.querySelectorAll<HTMLButtonElement>('[data-sample], #upload-btn').forEach((b) => (b.disabled = on));
          },
        }),
      );
    }
  } catch (err) {
    setBusy(false);
    showError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
  }
  await preview;
}

async function main() {
  const cfg = (await (await fetch('/api/config')).json()) as Config;
  if (!cfg.live) $('#paused').hidden = false;

  document.querySelectorAll<HTMLButtonElement>('[data-sample]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const s = cfg.samples.find((x) => x.id === btn.dataset.sample);
      if (!s) return;
      const bytes = await (await fetch(s.url)).arrayBuffer();
      await run(cfg, s.title, bytes, s.mediaType, (token) =>
        fetch(`/api/extract/sample/${s.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }),
        s.id,
      );
    });
  });

  const input = $<HTMLInputElement>('#file');
  const drop = $('#drop');
  const accept = async (file: File | undefined) => {
    if (!file || busy) return;
    if (file.size > cfg.limits.maxMb * 1024 * 1024) {
      $('#result').hidden = false;
      $('#doc-name').textContent = file.name;
      $('#pages').replaceChildren();
      return showError(`The file is larger than ${cfg.limits.maxMb} MB.`);
    }
    const bytes = await file.arrayBuffer();
    const type = /\.pdf$/i.test(file.name) || file.type === 'application/pdf' ? 'application/pdf' : file.type || 'image/jpeg';
    await run(cfg, file.name, bytes, type, (token) => fetch('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Turnstile-Token': token }, body: bytes }));
    input.value = '';
  };
  $('#upload-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => accept(input.files?.[0]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    accept(e.dataTransfer?.files[0]);
  });

  const base = () => (current?.name ?? 'reading').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  $('#export-csv').addEventListener('click', () => current && download(`${base()}.csv`, 'text/csv;charset=utf-8', csv(current.result)));
  $('#export-json').addEventListener('click', () => current && download(`${base()}.json`, 'application/json', JSON.stringify({ reading: current.result.reading, checks: current.result.flags }, null, 2)));

  // A link such as /?sample=westcountry-wrong-totals opens that sample straight away.
  const wanted = new URLSearchParams(location.search).get('sample');
  if (wanted) document.querySelector<HTMLButtonElement>(`[data-sample="${CSS.escape(wanted)}"]`)?.click();
}

main().catch(() => {
  $('#paused').hidden = false;
  $('#paused').textContent = 'The demo could not start. Please reload the page.';
});
