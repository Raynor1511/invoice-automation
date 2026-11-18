import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createApp, type SavedReading } from '../src/server/app.ts';
import { Guard, londonDay } from '../src/server/guard.ts';
import type { ExtractResult } from '../src/extract/extract.ts';

const ORIGIN = 'https://invoices.example';
const readings = new Map<string, SavedReading>(readdirSync('samples/readings').map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(`samples/readings/${f}`, 'utf8'))]));
const samples = [{ id: 'avon-invoice', file: 'avon-invoice.pdf', title: 'Parts invoice', blurb: 'x', order: 1 }];

let calls = 0;
let fail = false;
const extract = async (): Promise<ExtractResult> => {
  calls++;
  if (fail) throw new Error('API down');
  return { ok: true, data: readings.get('avon-invoice')!.extraction, model: 'claude-haiku-5-5', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.3, ms: 1234 };
};
const turnstileFetch = (async (_url: string, init: { body: URLSearchParams }) =>
  new Response(JSON.stringify(init.body.get('response') === 'good' ? { success: true, hostname: 'invoices.example' } : { success: false, 'error-codes': ['invalid-input-response'] }))) as unknown as typeof fetch;

let server: Server;
let base = '';
beforeAll(async () => {
  const app = createApp({
    origin: ORIGIN,
    extract,
    samples,
    sampleDir: 'samples/docs',
    readings,
    staticFiles: new Map([['/index.html', { body: Buffer.from('<h1>page</h1>'), type: 'text/html; charset=utf-8' }]]),
    turnstile: { siteKey: 'site', secret: 'secret', fetchImpl: turnstileFetch },
    guard: new Guard({ perTenMinutes: 4, perDay: 20, dailySpendUsd: 1 }),
  });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', body, headers: { Origin: ORIGIN, ...headers } });
const sample = (token = 'good') => post('/api/extract/sample/avon-invoice', JSON.stringify({ token }), { 'Content-Type': 'application/json' });

describe('demo service', () => {
  test('serves the page with security headers, the config and the samples', async () => {
    const page = await fetch(base + '/');
    expect(await page.text()).toContain('page');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self' https://challenges.cloudflare.com");
    const cfg = await (await fetch(base + '/api/config')).json();
    expect(cfg).toMatchObject({ turnstileSiteKey: 'site', live: true, limits: { maxMb: 5, maxPages: 5 }, samples: [{ id: 'avon-invoice', url: '/samples/avon-invoice.pdf' }] });
    const doc = await fetch(base + '/samples/avon-invoice.pdf');
    expect(doc.headers.get('content-type')).toBe('application/pdf');
    expect((await fetch(base + '/samples/harbour-waste-genuine.pdf')).status).toBe(404); // only the demo samples
    expect((await fetch(base + '/nope')).status).toBe(404);
  });

  test('POSTs from another origin are refused', async () => {
    const r = await post('/api/extract/sample/avon-invoice', '{}', { Origin: 'https://evil.example', 'Content-Type': 'application/json' });
    expect(r.status).toBe(403);
  });

  test('a sample is read live after the Turnstile check, with the checks applied', async () => {
    const before = calls;
    const r = await sample();
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j).toMatchObject({ ok: true, source: 'live', model: 'claude-haiku-5-5', seconds: 1.2, pages: 1, supplierOnFile: { id: 'avon' } });
    expect(Array.isArray(j.flags)).toBe(true);
    expect(calls).toBe(before + 1);
  });

  test('a failed Turnstile check stops the reading', async () => {
    const before = calls;
    const r = await sample('bad');
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('turnstile');
    expect(calls).toBe(before);
  });

  test('uploads are checked by content before any reading', async () => {
    const before = calls;
    const r = await post('/api/extract', Buffer.from('<html>not an invoice</html>'), { 'Content-Type': 'application/octet-stream', 'X-Turnstile-Token': 'good' });
    expect(r.status).toBe(415);
    expect((await r.json()).message).toBe('Please upload a PDF, JPG, PNG or WebP file.');
    expect(calls).toBe(before);
  });

  test('when the API fails, a sample falls back to its saved reading', async () => {
    fail = true;
    const before = calls;
    const j = await (await sample()).json();
    fail = false;
    expect(calls).toBe(before + 1); // the live reading was tried
    expect(j).toMatchObject({ ok: true, source: 'saved' });
    expect(j.notice).toBeTruthy();
  });

  test('over the limit, samples show their saved reading and uploads are refused', async () => {
    const before = calls;
    const s = await (await sample()).json();
    expect(s).toMatchObject({ source: 'saved' });
    expect(s.notice).toMatch(/wait ten minutes/);
    expect(calls).toBe(before);
    const r = await post('/api/extract', readFileSync('samples/docs/avon-invoice.pdf'), { 'Content-Type': 'application/octet-stream', 'X-Turnstile-Token': 'good' });
    expect(r.status).toBe(429);
    expect((await r.json()).message).toMatch(/wait ten minutes/);
  });
});

describe('guard', () => {
  test('limits per visitor, the daily cap, and the reset at London midnight', () => {
    let now = new Date('2026-11-18T23:30:00Z');
    const g = new Guard({ perTenMinutes: 2, perDay: 3, dailySpendUsd: 0.5 }, () => now);
    const v = g.visitor('203.0.113.9');
    expect(v).not.toContain('203');
    expect(g.take(v).ok && g.take(v).ok).toBe(true);
    expect(g.take(v)).toEqual({ ok: false, reason: 'per_ten_minutes' });
    now = new Date('2026-11-18T23:45:00Z');
    expect(g.take(v).ok).toBe(true);
    expect(g.take(v)).toEqual({ ok: false, reason: 'per_day' });
    g.record(0.6);
    expect(g.take(g.visitor('198.51.100.1'))).toEqual({ ok: false, reason: 'spend_cap' });
    now = new Date('2026-11-19T00:05:00Z');
    expect(londonDay(now)).toBe('2026-11-19');
    expect(g.spentToday()).toBe(0);
    expect(g.take(v).ok).toBe(true);
  });
});
