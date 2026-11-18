// The connection between the demo service and the n8n workflow ("Harbourline's inbox").
//  - n8n has no public address. The page's "send to inbox" and approval buttons, and Slack's button
//    clicks, reach it through this service, which forwards them on the private network.
//  - Slack's clicks are verified here (signing secret, five-minute window), because n8n's Code nodes
//    can't use Node's crypto module.
//  - n8n reads documents through an internal-only port (not proxied by Caddy), with a shared key.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkFile, type CheckedFile } from '../extract/files.ts';
import type { ExtractResult } from '../extract/extract.ts';
import type { Extraction } from '../extract/schema.ts';
import { checkExtraction } from '../extract/checks.ts';
import type { Guard } from './guard.ts';
import { londonDay } from './guard.ts';

export const SESSION = /^[a-z0-9-]{8,40}$/;
export const ROW_ID = /^INV-[0-9]{6}-[A-Z0-9]{4}$/;

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Slack's request signing: v0=HMAC-SHA256(secret, "v0:<timestamp>:<raw body>"), at most five minutes old. */
export function verifySlackSignature(secret: string, timestamp: string, body: string, signature: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > 300) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return sameSecret(expected, signature);
}

export type Decision = { source: 'page' | 'slack'; action: 'approve' | 'reject'; row: string; session: string | null; by: string; slack?: { channel: string; ts: string } };

/** Turns a Slack block_actions payload into a decision, or null if it isn't one of ours. */
export function slackDecision(formBody: string): Decision | null {
  const raw = new URLSearchParams(formBody).get('payload');
  if (!raw) return null;
  let p: {
    type?: string;
    actions?: { action_id?: string; value?: string }[];
    user?: { id?: string; username?: string; name?: string };
    container?: { channel_id?: string; message_ts?: string };
  };
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  const a = p.actions?.[0];
  if (p.type !== 'block_actions' || !a || (a.action_id !== 'approve' && a.action_id !== 'reject')) return null;
  let v: { row?: unknown; session?: unknown };
  try {
    v = JSON.parse(a.value ?? '{}');
  } catch {
    return null;
  }
  if (typeof v.row !== 'string' || !ROW_ID.test(v.row)) return null;
  const channel = p.container?.channel_id;
  const ts = p.container?.message_ts;
  return {
    source: 'slack',
    action: a.action_id,
    row: v.row,
    session: null, // anyone in the Slack channel may decide any invoice
    by: `${p.user?.name ?? p.user?.username ?? 'Someone'} (Slack)`,
    ...(channel && ts ? { slack: { channel, ts } } : {}),
  };
}

export type N8nClient = {
  inbox: (body: { sample: string; session: string }) => Promise<unknown>;
  decide: (d: Decision) => Promise<unknown>;
};

export function n8nClient(baseUrl: string, key: string, fetchImpl: typeof fetch = fetch): N8nClient {
  const call = async (hook: string, body: unknown) => {
    const res = await fetchImpl(`${baseUrl}/webhook/${hook}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error(`n8n ${hook}: HTTP ${res.status}`);
    return json;
  };
  return { inbox: (b) => call('invoice-inbox', b), decide: (d) => call('invoice-decision', d) };
}

export type InternalOptions = {
  key: string;
  extract: (file: CheckedFile) => Promise<ExtractResult>;
  sampleDir: string;
  sampleFiles: Map<string, string>; // id -> file
  readings: Map<string, { model: string; extraction: Extraction; costUsd: number; ms: number }>;
  guard: Guard;
  log?: (e: Record<string, unknown>) => void;
  now?: () => Date;
};

/**
 * The internal-only API that n8n calls (port 8081, private network):
 *   POST /internal/extract  {sample, seen?}  ->  the reading and the checks (duplicates against `seen`)
 * Live readings count towards the daily spending cap; once it is reached, the saved reading is used.
 */
export function createInternalApp(o: InternalOptions) {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => new Date());
  const json = (res: ServerResponse, status: number, body: unknown) => {
    const b = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(b.length) });
    res.end(b);
  };
  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://internal');
    if (req.method === 'GET' && url.pathname === '/internal/health') return json(res, 200, { ok: true });
    if (req.method !== 'POST' || url.pathname !== '/internal/extract') return json(res, 404, { ok: false });
    if (!sameSecret(String(req.headers['x-internal-key'] ?? ''), o.key)) return json(res, 401, { ok: false });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024) return json(res, 413, { ok: false });
      chunks.push(c as Buffer);
    }
    let body: { sample?: unknown; seen?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return json(res, 400, { ok: false, error: 'bad_json' });
    }
    const file = typeof body.sample === 'string' ? o.sampleFiles.get(body.sample) : undefined;
    if (!file) return json(res, 404, { ok: false, error: 'unknown_sample' });
    const seen = (body.seen && typeof body.seen === 'object' ? body.seen : {}) as Record<string, string[]>;
    const started = Date.now();
    let reading: Extraction;
    let meta: { source: 'live' | 'saved'; model: string; costUsd: number; ms: number };
    const saved = o.readings.get(body.sample as string);
    try {
      if (o.guard.capReached()) throw new Error('cap');
      const checked = await checkFile(readFileSync(path.join(o.sampleDir, file)));
      if (!checked.ok) throw new Error(checked.message);
      const r = await o.extract(checked.file);
      o.guard.record(r.costUsd);
      if (!r.ok) throw new Error(r.reason);
      reading = r.data;
      meta = { source: 'live', model: r.model, costUsd: r.costUsd, ms: r.ms };
    } catch (err) {
      if (!saved) return json(res, 502, { ok: false, error: 'extract_failed' });
      log({ level: 'warn', path: '/internal/extract', fallback: 'saved', reason: err instanceof Error ? err.message : String(err) });
      reading = saved.extraction;
      meta = { source: 'saved', model: saved.model, costUsd: 0, ms: saved.ms };
    }
    const result = checkExtraction(reading, { today: londonDay(now()), seen });
    log({ path: '/internal/extract', status: 200, source: meta.source, ms: Date.now() - started, spentToday: Number(o.guard.spentToday().toFixed(4)) });
    json(res, 200, {
      ok: true,
      sample: body.sample,
      source: meta.source,
      reading,
      flags: result.flags,
      supplier: result.supplier ? { id: result.supplier.id, name: result.supplier.name } : null,
      model: meta.model,
      costUsd: meta.costUsd,
      seconds: Math.round(meta.ms / 100) / 10,
    });
  };
}
