// The demo's HTTP service: the static page, the six sample documents and the extraction API.
//   GET  /api/config                 Turnstile site key, the samples, whether live readings are on
//   POST /api/extract                the visitor's own file as the raw request body (PDF, JPG, PNG, WebP)
//   POST /api/extract/sample/<id>    one of the samples (falls back to its saved reading when limits apply)
//   GET  /samples/<file>             a sample document, for the preview
//   GET  /api/health
// Uploaded files stay in memory for the length of the request: nothing is written to disk or logged.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { checkFile, LIMITS, type CheckedFile } from '../extract/files.ts';
import type { ExtractResult } from '../extract/extract.ts';
import type { Extraction } from '../extract/schema.ts';
import { checkExtraction } from '../extract/checks.ts';
import { Guard, REFUSAL_MESSAGES, londonDay, verifyTurnstile } from './guard.ts';
import { ROW_ID, SESSION, slackDecision, verifySlackSignature, type N8nClient } from './inbox.ts';

export type Sample = { id: string; file: string; title: string; blurb: string; order: number };
export type SavedReading = { model: string; extraction: Extraction; costUsd: number; ms: number };

export type AppOptions = {
  origin: string; // e.g. https://invoices.raynors.dev; POSTs from any other origin are refused
  extract: (file: CheckedFile) => Promise<ExtractResult>;
  samples: Sample[];
  sampleDir: string;
  readings: Map<string, SavedReading>;
  staticFiles?: Map<string, { body: Buffer; type: string }>;
  /** hostname: what Turnstile must report; defaults to the origin's (Cloudflare's test keys report example.com). */
  turnstile?: { siteKey: string; secret: string; hostname?: string; fetchImpl?: typeof fetch } | null;
  guard?: Guard;
  /** The n8n workflow ("Harbourline's inbox"); null turns the inbox part of the page off. */
  inbox?: { client: N8nClient; slackSigningSecret: string | null; sheetUrl: string } | null;
  trustProxy?: boolean;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => Date;
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
};

export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "worker-src 'self'",
      'frame-src https://challenges.cloudflare.com',
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

/** Every file of the built page, read once at start-up. */
export function loadStatic(dir: string): Map<string, { body: Buffer; type: string }> {
  const out = new Map<string, { body: Buffer; type: string }>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set('/' + path.relative(dir, full).split(path.sep).join('/'), { body: readFileSync(full), type: TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream' });
    }
  };
  walk(dir);
  return out;
}

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) return reject(new HttpError(413, 'too_large', 'The file is larger than 5 MB.'));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'too_large', 'The file is larger than 5 MB.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(o: AppOptions) {
  const guard = o.guard ?? new Guard();
  // Approve/Reject clicks on the page cost nothing, so they get their own, looser limit.
  const decisions = new Guard({ perTenMinutes: 30, perDay: 200, dailySpendUsd: Number.POSITIVE_INFINITY });
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => new Date());
  const statics = o.staticFiles ?? new Map();
  const host = new URL(o.origin).hostname;
  const sampleById = new Map(o.samples.map((s) => [s.id, s]));
  const sampleFiles = new Map(o.samples.map((s) => [s.file, s]));

  const clientIp = (req: IncomingMessage) => {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return (o.trustProxy && fwd.length ? fwd[fwd.length - 1] : req.socket.remoteAddress) ?? 'unknown';
  };

  function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
    const json = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(json.length), ...extra });
    res.end(json);
  }

  /** The reading plus the checks, in the shape the page shows. */
  function present(reading: Extraction, meta: { source: 'live' | 'saved'; model: string; costUsd: number; ms: number; file: CheckedFile | null }) {
    const result = checkExtraction(reading, { today: londonDay(now()) });
    return {
      ok: true,
      source: meta.source,
      reading,
      flags: result.flags,
      supplierOnFile: result.supplier ? { id: result.supplier.id, name: result.supplier.name } : null,
      model: meta.model,
      costUsd: meta.costUsd,
      seconds: Math.round(meta.ms / 100) / 10,
      ...(meta.file ? { pages: meta.file.pages, mediaType: meta.file.mediaType } : {}),
    };
  }

  async function humanCheck(req: IncomingMessage, token: string) {
    if (!o.turnstile) return; // local development
    const v = await verifyTurnstile(token, o.turnstile.secret, { remoteIp: clientIp(req), expectedHostname: o.turnstile.hostname ?? host, fetchImpl: o.turnstile.fetchImpl });
    if (!v.ok) throw new HttpError(403, 'turnstile', 'The check that you are a person did not go through. Please try again.');
  }

  async function live(file: CheckedFile) {
    const r = await o.extract(file);
    guard.record(r.costUsd);
    if (!r.ok) {
      const message = r.reason === 'refusal' ? 'This document could not be read. Please try a different one.' : 'The reading did not finish. Please try again, or try a shorter document.';
      throw new HttpError(422, r.reason, message);
    }
    return { r, data: r.data };
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<number> {
    const p = url.pathname;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/api/health') return send(res, 200, { ok: true }), 200;
      if (p === '/api/config') {
        send(res, 200, {
          turnstileSiteKey: o.turnstile?.siteKey ?? null,
          live: !guard.capReached(),
          limits: { maxMb: LIMITS.maxBytes / 1024 / 1024, maxPages: LIMITS.maxPages },
          inbox: o.inbox ? { sheetUrl: o.inbox.sheetUrl } : null,
          samples: [...o.samples].sort((a, b) => a.order - b.order).map((s) => ({ ...s, url: `/samples/${s.file}`, mediaType: s.file.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' })),
        });
        return 200;
      }
      if (p.startsWith('/samples/')) {
        const s = sampleFiles.get(p.slice('/samples/'.length));
        if (!s) throw new HttpError(404, 'not_found', 'Not found.');
        const body = readFileSync(path.join(o.sampleDir, s.file));
        res.writeHead(200, { ...securityHeaders(), 'Content-Type': TYPES[path.extname(s.file)]!, 'Content-Length': String(body.length), 'Cache-Control': 'public, max-age=3600' });
        res.end(req.method === 'HEAD' ? undefined : body);
        return 200;
      }
      const f = statics.get(p === '/' ? '/index.html' : p) ?? statics.get(`${p.replace(/\/$/, '')}/index.html`);
      if (f) {
        const immutable = p.startsWith('/_astro/');
        res.writeHead(200, { ...securityHeaders(), 'Content-Type': f.type, 'Content-Length': String(f.body.length), 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : f.body);
        return 200;
      }
      const notFound = statics.get('/404.html');
      res.writeHead(404, { ...securityHeaders(), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(notFound?.body ?? 'Not found');
      return 404;
    }

    if (req.method !== 'POST') throw new HttpError(405, 'method', 'Method not allowed.');

    // Slack's button clicks: checked against the signing secret, answered at once (Slack allows three
    // seconds), then passed to n8n on the private network.
    if (p === '/slack/interactions') {
      if (!o.inbox?.slackSigningSecret) throw new HttpError(404, 'not_found', 'Not found.');
      const body = (await readBody(req, 64 * 1024)).toString('utf8');
      const ok = verifySlackSignature(o.inbox.slackSigningSecret, String(req.headers['x-slack-request-timestamp'] ?? ''), body, String(req.headers['x-slack-signature'] ?? ''), Math.floor(now().getTime() / 1000));
      if (!ok) throw new HttpError(401, 'signature', 'Unauthorised.');
      res.writeHead(200, { 'Content-Length': '0' });
      res.end();
      const d = slackDecision(body);
      if (d) o.inbox.client.decide(d).catch((err) => log({ level: 'error', path: p, error: err instanceof Error ? err.message : String(err) }));
      return 200;
    }

    if (req.headers.origin !== o.origin) throw new HttpError(403, 'origin', 'Requests must come from the demo page.');
    const visitor = guard.visitor(clientIp(req));
    const readJson = async () => {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'content_type', 'Expected JSON.');
      try {
        return JSON.parse((await readBody(req, 4096)).toString('utf8')) as Record<string, unknown>;
      } catch {
        throw new HttpError(400, 'bad_request', 'The request could not be read.');
      }
    };

    // "Send to Harbourline's inbox": the n8n workflow reads the sample, checks it against this visitor's
    // earlier rows, adds it to the ledger and, if anything is flagged, asks for approval in Slack.
    const inboxMatch = /^\/api\/inbox\/sample\/([a-z0-9-]+)$/.exec(p);
    if (inboxMatch && o.inbox) {
      if (!sampleById.has(inboxMatch[1]!)) throw new HttpError(404, 'not_found', 'There is no sample with that name.');
      const b = await readJson();
      const session = String(b.session ?? '');
      if (!SESSION.test(session)) throw new HttpError(400, 'bad_request', 'The request could not be read.');
      if (guard.capReached()) throw new HttpError(429, 'spend_cap', REFUSAL_MESSAGES.spend_cap);
      const take = guard.take(visitor);
      if (!take.ok) throw new HttpError(429, take.reason, REFUSAL_MESSAGES[take.reason]);
      await humanCheck(req, String(b.token ?? ''));
      let result: unknown;
      try {
        result = await o.inbox.client.inbox({ sample: inboxMatch[1]!, session });
      } catch (err) {
        log({ level: 'error', path: p, error: err instanceof Error ? err.message : String(err) });
        throw new HttpError(502, 'workflow', "The workflow didn't answer. Please try again in a minute.");
      }
      send(res, 200, result);
      return 200;
    }

    if (p === '/api/inbox/decision' && o.inbox) {
      const b = await readJson();
      const session = String(b.session ?? '');
      const row = String(b.row ?? '');
      const action = b.action === 'approve' || b.action === 'reject' ? b.action : null;
      if (!SESSION.test(session) || !ROW_ID.test(row) || !action) throw new HttpError(400, 'bad_request', 'The request could not be read.');
      const take = decisions.take(visitor);
      if (!take.ok) throw new HttpError(429, take.reason, 'Too many clicks in a short time. Please wait a few minutes.');
      let result: unknown;
      try {
        result = await o.inbox.client.decide({ source: 'page', action, row, session, by: 'A website visitor' });
      } catch (err) {
        log({ level: 'error', path: p, error: err instanceof Error ? err.message : String(err) });
        throw new HttpError(502, 'workflow', "The workflow didn't answer. Please try again in a minute.");
      }
      send(res, 200, result);
      return 200;
    }

    const sampleMatch = /^\/api\/extract\/sample\/([a-z0-9-]+)$/.exec(p);
    if (sampleMatch) {
      const s = sampleById.get(sampleMatch[1]!);
      if (!s) throw new HttpError(404, 'not_found', 'There is no sample with that name.');
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'content_type', 'Expected JSON.');
      let token = '';
      try {
        token = String((JSON.parse((await readBody(req, 4096)).toString('utf8')) as { token?: unknown }).token ?? '');
      } catch {
        throw new HttpError(400, 'bad_request', 'The request could not be read.');
      }
      const saved = o.readings.get(s.id);
      const take = guard.take(visitor);
      if (!take.ok) {
        if (!saved) throw new HttpError(429, take.reason, REFUSAL_MESSAGES[take.reason]);
        send(res, 200, { ...present(saved.extraction, { source: 'saved', model: saved.model, costUsd: saved.costUsd, ms: saved.ms, file: null }), notice: REFUSAL_MESSAGES[take.reason] });
        return 200;
      }
      await humanCheck(req, token);
      const checked = await checkFile(readFileSync(path.join(o.sampleDir, s.file)));
      if (!checked.ok) throw new HttpError(500, 'sample', 'This sample could not be loaded.');
      try {
        const { r, data } = await live(checked.file);
        send(res, 200, present(data, { source: 'live', model: r.model, costUsd: r.costUsd, ms: r.ms, file: checked.file }));
      } catch (err) {
        if (!saved) throw err;
        log({ level: 'warn', path: p, error: err instanceof Error ? err.message : String(err) });
        send(res, 200, { ...present(saved.extraction, { source: 'saved', model: saved.model, costUsd: saved.costUsd, ms: saved.ms, file: null }), notice: 'A live reading is not available right now, so this is the saved reading of this sample.' });
      }
      return 200;
    }

    if (p === '/api/extract') {
      const token = String(req.headers['x-turnstile-token'] ?? '');
      const take = guard.take(visitor);
      if (!take.ok) throw new HttpError(429, take.reason, REFUSAL_MESSAGES[take.reason]);
      await humanCheck(req, token);
      const bytes = await readBody(req, LIMITS.maxBytes);
      const checked = await checkFile(bytes);
      if (!checked.ok) throw new HttpError(checked.error === 'too_large' ? 413 : 415, checked.error, checked.message);
      const { r, data } = await live(checked.file);
      send(res, 200, present(data, { source: 'live', model: r.model, costUsd: r.costUsd, ms: r.ms, file: checked.file }));
      return 200;
    }
    throw new HttpError(404, 'not_found', 'Not found.');
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now();
    let status = 500;
    let code: string | undefined;
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      status = await route(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        code = err.code;
        if (!res.headersSent) send(res, err.status, { ok: false, error: err.code, message: err.message });
      } else {
        code = 'internal';
        log({ level: 'error', path: url.pathname, error: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) send(res, 500, { ok: false, error: 'internal', message: 'Something went wrong on our side. Please try again.' });
      }
    }
    // Metadata only: never the file, the reading or the visitor's address.
    if (url.pathname.startsWith('/api/extract') || url.pathname.startsWith('/api/inbox')) log({ path: url.pathname, status, code, ms: Date.now() - started, spentToday: Number(guard.spentToday().toFixed(4)) });
  };
}
