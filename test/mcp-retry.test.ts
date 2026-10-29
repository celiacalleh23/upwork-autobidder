import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '../src/mcp';

// Upwork's per-minute limit (Celia, Oct 29): a call turned away is retried once after the wait Upwork asks for;
// confirm_preview never is.
const LIMIT = '{"error_code":"SENSITIVE_RATE_LIMIT_EXCEEDED","reason":"Rate limit exceeded for this tool. Wait about 0 seconds before retrying"}';
function fakeUpwork(limitedCalls: number) {
  const calls: string[] = [];
  let left = limitedCalls;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const m = JSON.parse(init.body);
    if (m.method === 'tools/call') calls.push(m.params.name);
    const limited = m.method === 'tools/call' && left-- > 0;
    const result = limited ? { isError: true, content: [{ type: 'text', text: LIMIT }] } : { structuredContent: { ok: true } };
    return new Response(m.id === undefined ? null : JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { status: m.id === undefined ? 202 : 200, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('McpClient and Upwork\'s per-minute limit', () => {
  it('waits and tries once more', async () => {
    const calls = fakeUpwork(1);
    expect(await new McpClient('https://x/mcp', 't').callTool('upwork__find_jobs', {})).toEqual({ ok: true });
    expect(calls).toEqual(['upwork__find_jobs', 'upwork__find_jobs']);
  });
  it('gives up after the second refusal', async () => {
    const calls = fakeUpwork(5);
    await expect(new McpClient('https://x/mcp', 't').callTool('upwork__find_jobs', {})).rejects.toThrow('RATE_LIMIT');
    expect(calls).toHaveLength(2);
  });
  it('never repeats a confirm', async () => {
    const calls = fakeUpwork(1);
    await expect(new McpClient('https://x/mcp', 't').callTool('upwork__confirm_preview', {})).rejects.toThrow('RATE_LIMIT');
    expect(calls).toEqual(['upwork__confirm_preview']);
  });
});
