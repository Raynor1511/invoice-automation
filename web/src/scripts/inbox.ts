// "Send to Harbourline's inbox": hands a sample to the n8n workflow, then shows what it did and,
// for a flagged invoice, the approval card it posted to Slack, with working buttons.
// Text from documents is only ever inserted as text nodes.

type Row = { id: string; status: string; checks?: string; supplier?: string; number?: string; total?: number | string; currency?: string; decidedBy?: string; decidedAt?: string };
type SendReply = { ok: true; row: Row; slack: boolean; sheetUrl: string; source: 'live' | 'saved' } | { ok: false; message?: string };
type DecideReply = { ok: true; row: Row } | { ok: false; reason?: string; row?: Row | null; message?: string };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | undefined> = {}, ...children: (Node | string | null | undefined | false)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** One random id per browser tab: the workflow checks duplicates, and lets visitors decide, within it. */
export function demoSession(): string {
  const make = () => crypto.randomUUID().toLowerCase();
  try {
    const have = sessionStorage.getItem('invoice-demo-session');
    if (have && /^[a-z0-9-]{8,40}$/.test(have)) return have;
    const s = make();
    sessionStorage.setItem('invoice-demo-session', s);
    return s;
  } catch {
    return make();
  }
}

const when = (stamp?: string) => (stamp ? stamp.slice(11, 16) : '');
const money = (v: number | string | undefined, currency = 'GBP') => {
  const n = Number(v);
  if (v === '' || v === undefined || Number.isNaN(n)) return '—';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
};

function statusClass(status: string) {
  return status === 'Needs review' ? 'warn' : status === 'Rejected' ? 'bad' : 'good';
}

function decisionLine(row: Row) {
  return h('p', { class: `decided ${statusClass(row.status)}` }, h('strong', {}, row.status), ` by ${row.decidedBy ?? 'someone'} at ${when(row.decidedAt)}.`);
}

function card(row: Row, decide: (action: 'approve' | 'reject') => Promise<DecideReply>) {
  const buttons = h('div', { class: 'card-actions' });
  const note = h('p', { class: 'card-note' });
  const approve = h('button', { type: 'button', class: 'btn btn-brand' }, 'Approve');
  const reject = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Reject');
  const click = (action: 'approve' | 'reject') => async () => {
    approve.disabled = reject.disabled = true;
    note.textContent = 'Updating the ledger…';
    try {
      const r = await decide(action);
      if (r.ok) {
        buttons.replaceWith(decisionLine(r.row));
        note.textContent = 'The ledger row and the Slack card have been updated.';
      } else if (r.reason === 'already_decided' && r.row) {
        buttons.replaceWith(decisionLine(r.row));
        note.textContent = 'This invoice had already been decided (perhaps in Slack).';
      } else {
        note.textContent = r.message ?? 'That did not go through. Please try again.';
        approve.disabled = reject.disabled = false;
      }
    } catch {
      note.textContent = 'That did not go through. Please try again.';
      approve.disabled = reject.disabled = false;
    }
  };
  approve.addEventListener('click', click('approve'));
  reject.addEventListener('click', click('reject'));
  buttons.append(approve, reject);
  return h(
    'div',
    { class: 'slack-card', role: 'group', 'aria-label': 'Approval card' },
    h('p', { class: 'card-from' }, h('span', { class: 'bot' }, 'Harbourline Invoices'), ' in #invoices'),
    h('p', { class: 'card-title' }, `Invoice to check: ${row.supplier || 'unknown supplier'}`),
    h('p', { class: 'card-meta' }, `${row.number || '—'} · ${money(row.total, row.currency)}`),
    h('ul', { class: 'card-checks' }, ...(row.checks ?? '').split('\n').filter(Boolean).map((l) => h('li', {}, l))),
    buttons,
    note,
  );
}

/**
 * Adds the inbox section to the result panel for a sample. `token` gets a Turnstile token.
 */
export function inboxSection(opts: { sample: string; sheetUrl: string; token: () => Promise<string>; onBusy: (busy: boolean) => void }) {
  const session = demoSession();
  const out = h('div', { class: 'inbox-result', 'aria-live': 'polite' });
  const send = h('button', { type: 'button', class: 'btn btn-brand' }, 'Send to the inbox');
  const ledgerLink = () => h('a', { href: opts.sheetUrl, target: '_blank', rel: 'noopener' }, 'Open the purchase ledger');
  const section = h(
    'section',
    { class: 'inbox', 'aria-label': "Send to Harbourline's inbox" },
    h('h3', {}, "Send to Harbourline's inbox"),
    h('p', { class: 'muted' }, 'An n8n workflow reads it, checks it against invoices already recorded, adds it to the purchase ledger (a Google Sheet), and posts an approval card to Slack if anything needs a person.'),
    send,
    out,
  );

  const decide = async (action: 'approve' | 'reject', row: string): Promise<DecideReply> => {
    const res = await fetch('/api/inbox/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session, row, action }) });
    return (await res.json()) as DecideReply;
  };

  send.addEventListener('click', async () => {
    send.disabled = true;
    opts.onBusy(true);
    out.replaceChildren(h('p', { class: 'working' }, 'The workflow is reading and filing the invoice…'));
    try {
      const token = await opts.token();
      const res = await fetch(`/api/inbox/sample/${opts.sample}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session, token }) });
      const r = (await res.json()) as SendReply;
      if (!r.ok) throw new Error(r.message ?? 'The workflow did not finish. Please try again.');
      const review = r.row.status === 'Needs review';
      out.replaceChildren(
        h('p', { class: `filed ${statusClass(r.row.status)}` }, 'Added to the ledger as ', h('strong', {}, r.row.id), ': ', h('strong', {}, r.row.status), '.'),
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, r.source === 'live' ? 'Read the document with AI and ran the checks.' : 'Used the saved reading (live readings are paused) and ran the checks.'),
          h('li', {}, 'Compared it with the invoices you have sent in this visit.'),
          h('li', {}, 'Added a row to the purchase ledger.'),
          h('li', {}, review ? 'Posted an approval card to #invoices in Slack.' : 'Nothing to approve, so no Slack card.'),
        ),
        review ? h('p', { class: 'muted' }, 'You can decide it here, as a manager would in Slack:') : '',
        review ? card(r.row, (a) => decide(a, r.row.id)) : '',
        h('p', {}, ledgerLink(), h('span', { class: 'muted' }, ' (read-only; demo rows are removed after 7 days)')),
      );
      send.textContent = 'Send it again';
    } catch (err) {
      out.replaceChildren(h('p', { class: 'inbox-error' }, err instanceof Error ? err.message : 'The workflow did not finish. Please try again.'));
    } finally {
      send.disabled = false;
      opts.onBusy(false);
    }
  });
  return section;
}
