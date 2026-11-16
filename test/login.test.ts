import { afterEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { MIN_DASH_PASSWORD_LENGTH } from '../src/auth';
import { environment } from './support/db';

const NOT_SET_UP = 'Login is not set up yet. Add the DASH_PASSWORD secret in Cloudflare.';
const TOO_SHORT = 'DASH_PASSWORD is too short. It must be at least 6 characters.';

const databases: ReturnType<typeof environment>[] = [];
afterEach(() => { databases.splice(0).forEach((e) => e.sqlite.close()); });

function envWith(password: string | undefined) {
  const e = environment();
  databases.push(e);
  if (password === undefined) delete e.DASH_PASSWORD;
  else e.DASH_PASSWORD = password;
  return e;
}

function loginRequest(method: 'GET' | 'POST', password?: string) {
  return new Request('https://local.invalid/login', method === 'GET' ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: password ?? '' }).toString(),
  });
}

describe('dashboard password length', () => {
  it('keeps the minimum at 6 characters', () => {
    expect(MIN_DASH_PASSWORD_LENGTH).toBe(6);
  });

  it('serves the login page and signs in when the password is 6 characters', async () => {
    const password = 'abcdef';
    expect(password).toHaveLength(MIN_DASH_PASSWORD_LENGTH);
    const e = envWith(password);

    const page = await worker.fetch(loginRequest('GET'), e);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Sign in');
    expect(html).not.toContain(TOO_SHORT);
    expect(html).not.toContain(NOT_SET_UP);

    const signIn = await worker.fetch(loginRequest('POST', password), e);
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get('location')).toBe('/');
    const setCookie = signIn.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^ab_session=\d+\.[A-Za-z0-9_-]+;/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');

    const home = await worker.fetch(new Request('https://local.invalid/', {
      headers: { cookie: setCookie.split(';')[0] },
    }), e);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Review queue');
  });

  it('returns 503 with the too-short message when the password is 5 characters', async () => {
    const e = envWith('abcde');
    for (const method of ['GET', 'POST'] as const) {
      const res = await worker.fetch(loginRequest(method, 'abcde'), e);
      expect(res.status).toBe(503);
      const html = await res.text();
      expect(html).toContain(TOO_SHORT);
      expect(html).not.toContain(NOT_SET_UP);
    }
  });

  it('returns 503 with the not-set-up message when the password is missing or empty', async () => {
    for (const password of [undefined, '', '   ']) {
      const e = envWith(password);
      for (const method of ['GET', 'POST'] as const) {
        const res = await worker.fetch(loginRequest(method, 'anything'), e);
        expect(res.status).toBe(503);
        const html = await res.text();
        expect(html).toContain(NOT_SET_UP);
        expect(html).not.toContain('too short');
      }
    }
  });
});
