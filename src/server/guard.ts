// Abuse protection for the public demo, all in memory (one container, nothing stored):
//  - Cloudflare Turnstile before every live extraction
//  - per-visitor limits, keyed by a salted hash of the IP address (the address itself is never kept)
//  - a daily spending cap for the whole demo; once reached, the samples are shown from saved readings
// Counters reset when the container restarts, which errs on the side of letting visitors in.
import { createHash, randomBytes } from 'node:crypto';

export type Limits = { perTenMinutes: number; perDay: number; dailySpendUsd: number };
export const DEFAULT_LIMITS: Limits = { perTenMinutes: 5, perDay: 20, dailySpendUsd: 1 };

export type Refusal = 'per_ten_minutes' | 'per_day' | 'spend_cap';

/** The current day in London, so limits reset at UK midnight. */
export function londonDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export class Guard {
  readonly limits: Limits;
  private now: () => Date;
  private salt = randomBytes(16);
  private hits = new Map<string, number[]>();
  private day = '';
  private spent = 0;

  // No parameter properties: Node runs this file with type stripping, which doesn't support them.
  constructor(limits: Limits = DEFAULT_LIMITS, now: () => Date = () => new Date()) {
    this.limits = limits;
    this.now = now;
  }

  visitor(ip: string): string {
    return createHash('sha256').update(this.salt).update(ip).digest('base64url').slice(0, 22);
  }

  private rollDay() {
    const d = londonDay(this.now());
    if (d !== this.day) {
      this.day = d;
      this.spent = 0;
      this.hits.clear();
    }
  }

  spentToday(): number {
    this.rollDay();
    return this.spent;
  }

  capReached(): boolean {
    return this.spentToday() >= this.limits.dailySpendUsd;
  }

  /** Counts one live extraction for this visitor, or says why it is refused. */
  take(visitor: string): { ok: true } | { ok: false; reason: Refusal } {
    this.rollDay();
    if (this.spent >= this.limits.dailySpendUsd) return { ok: false, reason: 'spend_cap' };
    const t = this.now().getTime();
    const list = this.hits.get(visitor) ?? [];
    if (list.length >= this.limits.perDay) return { ok: false, reason: 'per_day' };
    if (list.filter((x) => t - x < 10 * 60_000).length >= this.limits.perTenMinutes) return { ok: false, reason: 'per_ten_minutes' };
    list.push(t);
    this.hits.set(visitor, list);
    return { ok: true };
  }

  record(costUsd: number) {
    this.rollDay();
    this.spent += costUsd;
  }
}

export const REFUSAL_MESSAGES: Record<Refusal, string> = {
  per_ten_minutes: 'You have read several documents in the last few minutes. Please wait ten minutes and try again.',
  per_day: "You have reached today's limit for this demo. The sample documents still show their saved readings.",
  spend_cap: "The demo has reached its daily limit, so live readings are paused until tomorrow. The sample documents still show their saved readings.",
};

export async function verifyTurnstile(
  token: string,
  secret: string,
  opts: { remoteIp?: string; expectedHostname?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; reason?: string }> {
  if (!token || token.length > 2048) return { ok: false, reason: 'missing token' };
  const body = new URLSearchParams({ secret, response: token });
  if (opts.remoteIp) body.set('remoteip', opts.remoteIp);
  try {
    const res = await (opts.fetchImpl ?? fetch)('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    const data = (await res.json()) as { success: boolean; hostname?: string; 'error-codes'?: string[] };
    if (!data.success) return { ok: false, reason: (data['error-codes'] ?? []).join(',') || 'failed' };
    if (opts.expectedHostname && data.hostname && data.hostname !== opts.expectedHostname) return { ok: false, reason: `hostname ${data.hostname}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `verification unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
