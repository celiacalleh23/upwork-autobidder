import { describe, expect, it } from 'vitest';
import { parseSse } from '../src/mcp';
import { PASTE_REDIRECT_URI, paramsFromPasted, redirectUriFor, resolveToolNames } from '../src/oauth';

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

});
