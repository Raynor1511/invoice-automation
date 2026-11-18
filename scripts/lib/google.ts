// A Google access token from a service-account key (JWT bearer grant), for the setup scripts.
// The n8n workflows use n8n's own Google service-account credential instead.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export async function googleToken(keyFile: string, scope: string): Promise<string> {
  const key = JSON.parse(readFileSync(keyFile, 'utf8')) as { client_email: string; private_key: string };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 600 })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url')}`;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const j = (await res.json()) as { access_token?: string; error?: string };
  if (!j.access_token) throw new Error(`Google token: ${j.error ?? res.status}`);
  return j.access_token;
}
