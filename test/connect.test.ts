import { describe, expect, it } from 'vitest';
import { parseSse } from '../src/mcp';
import { PASTE_REDIRECT_URI, paramsFromPasted, redirectUriFor, resolveToolNames } from '../src/oauth';
import { scanDue } from '../src/pipeline/scan';

describe('MCP and Upwork connection helpers', () => {
  it('parses SSE events, skipping non-JSON ones', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n: keep-alive\n\ndata: {"a":\ndata: 1}\n\n';
    expect(parseSse(body)).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }, { a: 1 }]);
  });

  it('resolves tool names with or without a prefix', () => {
    expect(resolveToolNames(['upwork__find_jobs', 'list_accounts', 'other'])).toEqual({ find_jobs: 'upwork__find_jobs', list_accounts: 'list_accounts' });
  });

  it('uses the paste redirect everywhere except local dev', () => {
    expect(redirectUriFor('https://upwork-autobidder.siv-4c9.workers.dev')).toBe(PASTE_REDIRECT_URI);
    expect(redirectUriFor('http://localhost:8787')).toBe('http://localhost:8787/oauth/upwork/callback');
  });

  it('reads code and state from a pasted address', () => {
    const p = paramsFromPasted(' http://127.0.0.1:53682/upwork-callback?code=abc&state=xyz ');
    expect([p.get('code'), p.get('state')]).toEqual(['abc', 'xyz']);
    expect(paramsFromPasted('error=access_denied&state=x').get('error')).toBe('access_denied');
    expect(() => paramsFromPasted('http://127.0.0.1:53682/upwork-callback')).toThrow(/no sign-in code/);
  });

  it('decides when a scan is due', () => {
    const now = Date.parse('2026-10-21T15:00:00Z');
    expect(scanDue(null, 5, now)).toBe(true);
    expect(scanDue('2026-10-21T14:55:20Z', 5, now)).toBe(true);  // 4m40s ago: within the 30 s slack
    expect(scanDue('2026-10-21T14:57:00Z', 5, now)).toBe(false);
  });
});
