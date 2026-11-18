import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createApp, type SavedReading } from '../src/server/app.ts';
import { Guard } from '../src/server/guard.ts';
import { createInternalApp, slackDecision, verifySlackSignature, type Decision } from '../src/server/inbox.ts';
import type { ExtractResult } from '../src/extract/extract.ts';

const SECRET = 'a'.repeat(32);
const KEY = 'k'.repeat(40);
const ORIGIN = 'https://invoices.example';
const sign = (body: string, ts: number, secret = SECRET) => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
const readings = new Map<string, SavedReading>(readdirSync('samples/readings').map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(`samples/readings/${f}`, 'utf8'))]));
const slackBody = (action: string, value: unknown) =>
  new URLSearchParams({
    payload: JSON.stringify({ type: 'block_actions', user: { id: 'U1', name: 'sam' }, container: { channel_id: 'C1', message_ts: '1.2' }, actions: [{ action_id: action, value: JSON.stringify(value) }] }),
  }).toString();

describe('Slack signature', () => {
  const now = 1_800_000_000;
  test('a correctly signed, recent request passes', () => {
    expect(verifySlackSignature(SECRET, String(now), 'x=1', sign('x=1', now), now + 10)).toBe(true);
  });
  test('a changed body, a wrong secret or an old timestamp fails', () => {
    expect(verifySlackSignature(SECRET, String(now), 'x=2', sign('x=1', now), now)).toBe(false);
    expect(verifySlackSignature(SECRET, String(now), 'x=1', sign('x=1', now, 'b'.repeat(32)), now)).toBe(false);
    expect(verifySlackSignature(SECRET, String(now), 'x=1', sign('x=1', now), now + 301)).toBe(false);
    expect(verifySlackSignature(SECRET, 'soon', 'x=1', sign('x=1', now), now)).toBe(false);
  });
});

describe('Slack payloads', () => {
  test('an approve click becomes a decision for that row', () => {
    expect(slackDecision(slackBody('approve', { row: 'INV-261119-AB12' }))).toEqual({ source: 'slack', action: 'approve', row: 'INV-261119-AB12', session: null, by: 'sam (Slack)', slack: { channel: 'C1', ts: '1.2' } });
  });
  test('anything else is ignored', () => {
    expect(slackDecision(slackBody('delete', { row: 'INV-261119-AB12' }))).toBeNull();
    expect(slackDecision(slackBody('approve', { row: '../etc' }))).toBeNull();
    expect(slackDecision('payload=not-json')).toBeNull();
    expect(slackDecision('')).toBeNull();
  });
});

describe('inbox routes', () => {
  const sent: unknown[] = [];
  const decided: Decision[] = [];
  let server: Server;
  let base = '';
  let now = new Date('2026-11-19T10:00:00Z');
  beforeAll(async () => {
    const app = createApp({
      origin: ORIGIN,
      extract: async () => { throw new Error('not used'); },
      samples: [{ id: 'avon-invoice', file: 'avon-invoice.pdf', title: 't', blurb: 'b', order: 1 }],
      sampleDir: 'samples/docs',
      readings,
      guard: new Guard({ perTenMinutes: 2, perDay: 20, dailySpendUsd: 1 }),
      inbox: {
        client: {
          inbox: async (b) => (sent.push(b), { ok: true, row: { id: 'INV-261119-AB12', status: 'Needs review' } }),
          decide: async (d) => (decided.push(d), { ok: true, row: { id: d.row, status: d.action === 'approve' ? 'Approved' : 'Rejected' } }),
        },
        slackSigningSecret: SECRET,
        sheetUrl: 'https://docs.google.com/spreadsheets/d/x',
      },
      now: () => now,
    });
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const post = (path: string, body: string, headers: Record<string, string>) => fetch(base + path, { method: 'POST', body, headers });
  const json = { Origin: ORIGIN, 'Content-Type': 'application/json' };

  test('the config tells the page where the ledger is', async () => {
    expect((await (await fetch(base + '/api/config')).json()).inbox).toEqual({ sheetUrl: 'https://docs.google.com/spreadsheets/d/x' });
  });

  test('sending a sample passes the sample and session to n8n', async () => {
    const r = await post('/api/inbox/sample/avon-invoice', JSON.stringify({ session: 'abcd1234-ef', token: '' }), json);
    expect(r.status).toBe(200);
    expect(sent.at(-1)).toEqual({ sample: 'avon-invoice', session: 'abcd1234-ef' });
    expect((await post('/api/inbox/sample/avon-invoice', JSON.stringify({ session: 'BAD SESSION' }), json)).status).toBe(400);
    expect((await post('/api/inbox/sample/nope', JSON.stringify({ session: 'abcd1234-ef' }), json)).status).toBe(404);
  });

  test("sending counts towards the visitor's reading limit", async () => {
    // The limit is 2 per ten minutes and one send has been made.
    expect((await post('/api/inbox/sample/avon-invoice', JSON.stringify({ session: 'abcd1234-ef' }), json)).status).toBe(200);
    expect((await post('/api/inbox/sample/avon-invoice', JSON.stringify({ session: 'abcd1234-ef' }), json)).status).toBe(429);
  });

  test('a decision from the page names the session, so n8n can check the row is theirs', async () => {
    const r = await post('/api/inbox/decision', JSON.stringify({ session: 'abcd1234-ef', row: 'INV-261119-AB12', action: 'reject' }), json);
    expect((await r.json()).row.status).toBe('Rejected');
    expect(decided.at(-1)).toEqual({ source: 'page', action: 'reject', row: 'INV-261119-AB12', session: 'abcd1234-ef', by: 'A website visitor' });
    expect((await post('/api/inbox/decision', JSON.stringify({ session: 'abcd1234-ef', row: 'INV-1', action: 'approve' }), json)).status).toBe(400);
  });

  test('Slack clicks need a valid signature, and no Origin header', async () => {
    const ts = Math.floor(now.getTime() / 1000);
    const body = slackBody('approve', { row: 'INV-261119-ZZ99' });
    const bad = await post('/slack/interactions', body, { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Slack-Request-Timestamp': String(ts), 'X-Slack-Signature': sign(body + 'x', ts) });
    expect(bad.status).toBe(401);
    const good = await post('/slack/interactions', body, { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Slack-Request-Timestamp': String(ts), 'X-Slack-Signature': sign(body, ts) });
    expect(good.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(decided.at(-1)).toMatchObject({ source: 'slack', action: 'approve', row: 'INV-261119-ZZ99' });
    now = new Date(now.getTime() + 10 * 60_000);
    const stale = await post('/slack/interactions', body, { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Slack-Request-Timestamp': String(ts), 'X-Slack-Signature': sign(body, ts) });
    expect(stale.status).toBe(401);
  });
});

describe('internal API for n8n', () => {
  let server: Server;
  let base = '';
  let fail = false;
  const extract = async (): Promise<ExtractResult> => {
    if (fail) throw new Error('API down');
    return { ok: true, data: readings.get('avon-invoice')!.extraction, model: 'claude-haiku-5-5', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.001, ms: 2000 };
  };
  beforeAll(async () => {
    const handle = createInternalApp({ key: KEY, extract, sampleDir: 'samples/docs', sampleFiles: new Map([['avon-invoice', 'avon-invoice.pdf']]), readings, guard: new Guard(), now: () => new Date('2026-11-19T10:00:00Z') });
    server = createServer(handle);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const call = (body: unknown, key = KEY) => fetch(base + '/internal/extract', { method: 'POST', headers: { 'X-Internal-Key': key }, body: JSON.stringify(body) });

  test('the key is required', async () => {
    expect((await call({ sample: 'avon-invoice' }, 'wrong')).status).toBe(401);
  });

  test('a reading with the checks; invoice numbers already seen are flagged as duplicates', async () => {
    const first = await (await call({ sample: 'avon-invoice' })).json();
    expect(first).toMatchObject({ ok: true, source: 'live', supplier: { id: 'avon' } });
    expect(first.flags).toEqual([]);
    const again = await (await call({ sample: 'avon-invoice', seen: { avon: ['aps-104772'] } })).json();
    expect(again.flags.map((f: { code: string }) => f.code)).toContain('duplicate');
  });

  test('when the API fails, the saved reading is used', async () => {
    fail = true;
    const r = await (await call({ sample: 'avon-invoice' })).json();
    fail = false;
    expect(r).toMatchObject({ ok: true, source: 'saved', costUsd: 0 });
    expect((await call({ sample: 'nope' })).status).toBe(404);
  });
});
