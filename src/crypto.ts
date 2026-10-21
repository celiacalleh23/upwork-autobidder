import type { Env } from './settings';

// AES-GCM encryption for secrets at rest (Upwork tokens, later the Loom cookie), keyed from TOKEN_KEY.
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

export class MissingKey extends Error {}

export const tokenKeyConfigured = (env: Env) => (env.TOKEN_KEY ?? '').length >= 32;

async function aesKey(env: Env): Promise<CryptoKey> {
  if (!tokenKeyConfigured(env)) throw new MissingKey('Add the TOKEN_KEY secret in Cloudflare (32+ random characters) first.');
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`${env.TOKEN_KEY}|at-rest-v1`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(env: Env, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(JSON.stringify(value)));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

// Returns null when the value can't be decrypted (e.g. TOKEN_KEY was changed): callers treat that as "not connected".
export async function unseal<T>(env: Env, sealed: string): Promise<T | null> {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, await aesKey(env), fromB64url(ct));
    return JSON.parse(dec.decode(pt)) as T;
  } catch (e) {
    if (e instanceof MissingKey) throw e;
    return null;
  }
}

export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256b64url(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
