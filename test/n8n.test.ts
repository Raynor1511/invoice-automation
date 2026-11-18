import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { COLUMNS, STATUS, col, objectToRow, rowToObject } from '../n8n/src/ledger.mjs';
import { applyDecision, approvalCard, decidedCard, expiredRows, ledgerRow, londonStamp, newRowId, seenForSession, slackEscape, weeklySummary } from '../n8n/src/invoices.mjs';

const reading = JSON.parse(readFileSync('samples/readings/westcountry-wrong-totals.json', 'utf8')).extraction;
const flags = [
  { code: 'line_math', severity: 'error', field: 'line_items.1.line_total', message: 'Line 2: 6 × 18.90 is 113.40, but the line says 123.40.' },
  { code: 'net_vat_total', severity: 'error', field: 'total', message: 'Net 995.90 + VAT 199.18 is 1195.08, but the total says 1295.08.' },
];
const extract = { reading, flags, supplier: { id: 'westcountry-tile', name: 'Westcountry Tile & Bathroom' } };
const now = new Date('2026-11-19T10:32:05Z');
const SHEET = 'https://docs.google.com/spreadsheets/d/x';

describe('ledger layout', () => {
  test('rows convert to and from sheet arrays, column letters line up', () => {
    const row = ledgerRow({ id: 'INV-261119-AB12', extract, session: 's-12345678', sampleTitle: 'Totals that don’t add up', now });
    const back = rowToObject(objectToRow(row), 2);
    expect(back).toEqual({ ...row, rowNumber: 2 });
    expect(col('id')).toBe('A');
    expect(col('slack')).toBe(String.fromCharCode(64 + COLUMNS.length));
  });
});

describe('workflow logic', () => {
  test('London time stamps and row ids', () => {
    expect(londonStamp(now)).toBe('2026-11-19 10:32:05');
    expect(londonStamp(new Date('2026-07-01T23:30:00Z'))).toBe('2026-07-02 00:30:00'); // summer time
    expect(newRowId(now, () => 0)).toBe('INV-261119-AAAA');
    expect(newRowId(now, Math.random)).toMatch(/^INV-261119-[A-Z2-9]{4}$/);
  });

  test("a flagged reading needs review; the session's earlier invoices feed the duplicate check", () => {
    const row = ledgerRow({ id: 'INV-261119-AB12', extract, session: 's-12345678', sampleTitle: 'X', now });
    expect(row).toMatchObject({ status: STATUS.review, supplier: 'Westcountry Tile & Bathroom', onFile: 'Yes', number: 'WTB-30417', total: 1295.08, supplierId: 'westcountry-tile' });
    expect(row.checks).toBe(`Check: ${flags[0]!.message}\nCheck: ${flags[1]!.message}`);
    expect(ledgerRow({ id: 'INV-261119-AB13', extract: { ...extract, flags: [] }, session: 's', sampleTitle: 'X', now }).status).toBe(STATUS.ready);
    const rows = [row, { ...row, session: 'someone-else', number: 'OTHER-1' }];
    expect(seenForSession(rows, 's-12345678')).toEqual({ 'westcountry-tile': ['WTB-30417'] });
  });

  test('decisions: own rows only from the page, any row from Slack, once', () => {
    const row = { ...ledgerRow({ id: 'INV-261119-AB12', extract, session: 's-12345678', sampleTitle: 'X', now }), rowNumber: 2 };
    const fromPage = { source: 'page', action: 'approve', row: row.id, session: 's-12345678', by: 'A website visitor' };
    expect(applyDecision([row], { ...fromPage, session: 'not-mine-123' }, now)).toEqual({ ok: false, reason: 'not_found' });
    const ok = applyDecision([row], fromPage, now);
    expect(ok).toMatchObject({ ok: true, row: { status: STATUS.approved, decidedBy: 'A website visitor', decidedAt: '2026-11-19 10:32:05', rowNumber: 2 } });
    expect(applyDecision([ok.row!], { ...fromPage, action: 'reject' }, now)).toMatchObject({ ok: false, reason: 'already_decided' });
    expect(applyDecision([row], { source: 'slack', action: 'reject', row: row.id, session: null, by: 'sam (Slack)' }, now)).toMatchObject({ ok: true, row: { status: STATUS.rejected } });
    expect(applyDecision([row], { ...fromPage, row: '=HYPERLINK(1)' }, now)).toEqual({ ok: false, reason: 'invalid' });
  });

  test('Slack cards: buttons carry only the row id; document text is escaped', () => {
    const row = { ...ledgerRow({ id: 'INV-261119-AB12', extract, session: 's', sampleTitle: 'X', now }), number: '<!channel> & co' };
    const card = approvalCard(row, SHEET);
    const json = JSON.stringify(card);
    expect(json).not.toContain('<!channel>');
    expect(json).toContain('&lt;!channel&gt; &amp; co');
    const actions = card.blocks.find((b: { type: string }) => b.type === 'actions') as { elements: { value: string }[] };
    expect(actions.elements.map((e) => JSON.parse(e.value))).toEqual([{ row: 'INV-261119-AB12' }, { row: 'INV-261119-AB12' }]);
    const decided = decidedCard({ ...row, status: STATUS.approved, decidedBy: 'sam (Slack)', decidedAt: '2026-11-19 10:40:00' }, SHEET);
    expect(JSON.stringify(decided)).not.toContain('"actions"');
    expect(JSON.stringify(decided)).toContain('Approved* by sam (Slack)');
    expect(slackEscape('a<b>&')).toBe('a&lt;b&gt;&amp;');
  });

  test('rows older than seven days expire, newest kept, deleted bottom-up', () => {
    const rows = [
      { rowNumber: 2, added: '2026-11-10 09:00:00' },
      { rowNumber: 3, added: '2026-11-12 10:31:00' },
      { rowNumber: 4, added: '2026-11-12 10:33:00' },
      { rowNumber: 5, added: '' },
    ];
    expect(expiredRows(rows, now)).toEqual([3, 2]);
  });

  test('weekly summary: counts, totals by supplier, waiting for approval', () => {
    const base = ledgerRow({ id: 'INV-261119-AB12', extract, session: 's', sampleTitle: 'X', now });
    const rows = [
      { ...base, status: STATUS.review },
      { ...base, id: 'INV-261119-AB13', status: STATUS.ready, total: 100 },
      { ...base, id: 'INV-261101-AB14', added: '2026-11-01 09:00:00', status: STATUS.approved },
    ];
    const s = weeklySummary(rows, now, SHEET);
    const text = JSON.stringify(s);
    expect(s.text).toBe('Supplier invoices this week: 2');
    expect(text).toContain('*2* invoices recorded: 1 passed every check, 0 approved after a check, 0 rejected.');
    expect(text).toContain('*1* waiting for approval.');
    expect(text).toContain('Westcountry Tile &amp; Bathroom: £1,395.08');
  });
});

describe('generated workflows', async () => {
  const { WORKFLOWS, CRED } = await import('../n8n/build.mjs');
  type Node = { name: string; type: string; parameters: { jsCode?: string }; credentials?: Record<string, { id: string; name: string }> };
  type Wf = { name: string; nodes: Node[]; settings: { errorWorkflow?: string } };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  /** Runs a Code node's script with stand-ins for n8n's $input and $("Node"). */
  const run = (wf: Wf, node: string, input: unknown, others: Record<string, unknown> = {}) => {
    const js = wf.nodes.find((n) => n.name === node)!.parameters.jsCode!;
    const $ = (name: string) => ({ first: () => ({ json: others[name] }) });
    return new AsyncFunction('$input', '$', js)({ first: () => ({ json: input }) }, $);
  };
  const byName = (n: string) => (WORKFLOWS as Wf[]).find((w) => w.name === `Invoices · ${n}`)!;

  test('every Code node compiles, every credential is one of ours, every workflow reports errors to Alerts', () => {
    for (const wf of WORKFLOWS as Wf[]) {
      for (const n of wf.nodes) {
        if (n.parameters.jsCode) expect(() => new AsyncFunction('$input', '$', n.parameters.jsCode), `${wf.name} / ${n.name}`).not.toThrow();
        for (const c of Object.values(n.credentials ?? {})) expect(Object.values(CRED)).toContain(c.name);
      }
      if (wf.name !== 'Invoices · Alerts') expect(wf.settings.errorWorkflow).toBe('__WORKFLOW__Invoices · Alerts');
    }
  });

  test('inbox: a request is checked, and a flagged reading becomes a row, a card and a reply', async () => {
    const inbox = byName('Inbox');
    await expect(run(inbox, 'Check request', { body: { sample: '../x', session: 'abcdefgh' } })).rejects.toThrow('Invalid inbox request');
    const req = (await run(inbox, 'Check request', { body: { sample: 'westcountry-wrong-totals', session: 'abcdefgh-1' } }))[0].json;
    expect(req).toEqual({ sample: 'westcountry-wrong-totals', session: 'abcdefgh-1', title: 'Totals that don’t add up' });
    const seen = (await run(inbox, 'Earlier invoices in this session', null, { 'Check request': req, 'Read the ledger': { values: [] } }))[0].json;
    expect(seen).toEqual({ sample: 'westcountry-wrong-totals', seen: {} });
    const out = (await run(inbox, 'Ledger row', { ...extract, source: 'live', model: 'claude-haiku-5-5', costUsd: 0.001, seconds: 4.2 }, { 'Check request': req }))[0].json;
    expect(out.row.status).toBe('Needs review');
    expect(out.values).toHaveLength(COLUMNS.length);
    expect(out.card.blocks.some((b: { type: string }) => b.type === 'actions')).toBe(true);
    expect(out.reply).toMatchObject({ ok: true, slack: true, row: { status: 'Needs review', supplier: 'Westcountry Tile & Bathroom' } });
    expect(out.reply.row).not.toHaveProperty('session');
  });

  test('decision: a page click on a row from another session is refused', async () => {
    const decision = byName('Decision');
    const row = objectToRow({ ...ledgerRow({ id: 'INV-261119-AB12', extract, session: 'mine-1234', sampleTitle: 'X', now }), slack: 'C1/1.2' });
    const ledger = { 'Read the ledger': { values: [row] } };
    const theirs = (await run(decision, 'Apply the decision', null, { ...ledger, 'Decision arrives': { body: { source: 'page', action: 'approve', row: 'INV-261119-AB12', session: 'other-1234', by: 'A website visitor' } } }))[0].json;
    expect(theirs).toMatchObject({ ok: false, reply: { ok: false, reason: 'not_found' } });
    const mine = (await run(decision, 'Apply the decision', null, { ...ledger, 'Decision arrives': { body: { source: 'page', action: 'approve', row: 'INV-261119-AB12', session: 'mine-1234', by: 'A website visitor' } } }))[0].json;
    expect(mine).toMatchObject({ ok: true, rowNumber: 2, slack: { channel: 'C1', ts: '1.2' }, reply: { row: { status: 'Approved' } } });
  });
});
