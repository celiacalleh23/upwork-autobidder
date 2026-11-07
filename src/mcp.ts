import type { Env } from './settings';
import { permitSearch, permitUpworkCall, permitJobRead, recordUpworkError } from './upworkPace';

// Minimal MCP client over Streamable HTTP: initialize → notifications/initialized → tools/list / tools/call.

const PROTOCOL_VERSION = '2025-06-18';

export class McpAuthError extends Error {}
export class McpError extends Error {}
// The tool ran and answered with an error (isError): Upwork gave a definite answer, unlike a dropped connection or 5xx.
export class McpToolError extends McpError {}
export class McpJobAccessError extends McpToolError {
  constructor(message: string, public readonly context: { jobId: string; orgUid: string; reason: string; traceId: string | null }) { super(message); }
}


interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// Upwork's per-minute limit (Oct 29: "Wait about 5 seconds before retrying (~12 requests/min sustained for find_jobs,
// find_freelancers, get_profile, and write tools). There is no daily cap"). Returns how long Upwork asked to wait, in ms
// (its own figure plus a second, at most 31 s), or null when the error is not that limit. An account warning is never
// a wait: it pauses bidding (BUILD_PLAN §2). Oct 30, find_jobs: "Your access to search has been restricted due to
// violations of our Terms of Service ... Changing search parameters or immediately retrying ...".
export const isAccountWarning = (msg: string) =>
  /account (warning|restricted|suspended)|unusual activity|terms of service|violation|(access|account)\b.{0,40}\b(restricted|suspended|blocked|banned|disabled)/i.test(msg);
export function throttleWait(e: unknown): number | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (isAccountWarning(msg) || !/rate.?limit|too many requests|\b429\b/i.test(msg)) return null;
  const m = /wait about (\d+) seconds?|retry_after\D{0,6}(\d+)/i.exec(msg);
  return Math.max(0, Number(m?.[1] ?? m?.[2] ?? 10)) * 1000 + 1000;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

// Each SSE event's data: lines joined with newlines, parsed as JSON. Non-JSON events are skipped.
export function parseSse(body: string): unknown[] {
  const out: unknown[] = [];
  for (const event of body.replaceAll('\r\n', '\n').split(/\n\n+/)) {
    const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* keep-alive or partial event */ }
  }
  return out;
}

export class McpClient {
  confirmGuard?: () => Promise<void>;
  private sessionId: string | null = null;
  private protocol = PROTOCOL_VERSION;
  private nextId = 1;

  constructor(private url: string, private token: string, private timeoutMs = 25_000, private env?: Env, private scanOnly = false) {}

  private async post(body: object): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
      'mcp-protocol-version': this.protocol,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 401 || res.status === 403) throw new McpAuthError(`Upwork refused the sign-in (${res.status})`);
    return res;
  }

  private async request(method: string, params: object): Promise<unknown> {
    try { return await this.requestOnce(method, params); }
    catch (e) { if (this.env) await recordUpworkError(this.env, e); throw e; }
  }

  private async requestOnce(method: string, params: object): Promise<unknown> {
    const tool = params as { name?: string; arguments?: { action?: string } };
    if (this.env && method === 'tools/call' && tool.name?.split(/__|\./).pop() === 'find_jobs' && tool.arguments?.action === 'get') await permitJobRead(this.env);
    if (this.env) await permitUpworkCall(this.env, method === 'tools/call');
    if (method === 'tools/call' && /confirm_preview$/.test(String((params as { name?: string }).name))) {
      if (this.confirmGuard) await this.confirmGuard();
    }
    if (this.env && method === 'tools/call') {
      const p = params as { name?: string; arguments?: { action?: string } };
      if ((p.name ?? '').split(/__|\./).pop() === 'find_jobs' && ['search', 'smart_search'].includes(p.arguments?.action ?? '')) await permitSearch(this.env, this.scanOnly);
    }
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params });
    if (!res.ok) {
      const header = res.headers.get('retry-after');
      const wait = header ? (/^\d+$/.test(header) ? Number(header) : Math.max(0, Math.ceil((Date.parse(header) - Date.now()) / 1000))) : NaN;
      const retry = res.status === 429 && Number.isFinite(wait) ? ` retry_after: ${wait}` : '';
      throw new McpError(`Upwork MCP ${method} failed (${res.status})${retry}: ${(await res.text()).slice(0, 200)}`);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    const messages = (type.includes('text/event-stream') ? parseSse(text) : [JSON.parse(text)]) as RpcMessage[];
    const msg = messages.find((m) => m && m.id === id);
    if (!msg) throw new McpError(`Upwork MCP ${method}: no response`);
    if (msg.error) throw new McpError(`Upwork MCP ${method}: ${msg.error.message}`);
    return msg.result;
  }

  async initialize(): Promise<void> {
    const result = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'upwork-autobidder', version: '0.1.0' },
    })) as { protocolVersion?: string };
    if (result?.protocolVersion) this.protocol = result.protocolVersion;
    const res = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await res.body?.cancel();
  }

  async listTools(): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: { name: string }[]; nextCursor?: string };
      names.push(...(r.tools ?? []).map((t) => t.name));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return names;
  }

  // Returns the tool's structured content, or its text parsed as JSON when possible (else the raw text). When Upwork's
  // per-minute limit turns a call away, it waits as long as Upwork asks and tries once more (Celia, Oct 29). Never for
  // confirm_preview: a confirm is sent at most once per run, and a refused one waits for the next run (send.ts).
  async callTool(name: string, args: object): Promise<unknown> {
    if (this.scanOnly) {
      const base = name.split(/__|\./).pop();
      const action = (args as { action?: string }).action;
      if (base !== 'list_accounts' && !(base === 'find_jobs' && action === 'search')) throw new McpError('Scan-only connection cannot call this Upwork tool.');
    }
    try {
      return await this.callOnce(name, args);
    } catch (e) {
      const wait = /confirm_preview$/.test(name) ? null : throttleWait(e);
      if (wait !== null && wait > 30_000) throw e;
      if (wait === null) throw e;
      await sleep(wait);
      return await this.callOnce(name, args);
    }
  }

  private async callOnce(name: string, args: object): Promise<unknown> {
    try { return await this.callToolOnce(name, args); }
    catch (e) { if (this.env) await recordUpworkError(this.env, e); throw e; }
  }

  private async callToolOnce(name: string, args: object): Promise<unknown> {
    const r = (await this.request('tools/call', { name, arguments: args })) as ToolResult;
    const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (r.isError) {
      const message = `Upwork ${name.replace(/^.*__/, '')}: ${text.slice(0, 300) || 'error'}`;
      const input = args as { action?: string; org_uid?: string; params?: { id?: string } };
      let detail: { error_code?: unknown; reason?: unknown; trace_id?: unknown } | null = null;
      try { detail = JSON.parse(text); } catch { /* unstructured errors keep normal handling */ }
      if (!isAccountWarning(text) && name.split(/__|\./).pop() === 'find_jobs' && input.action === 'get'
        && detail?.error_code === 'PERMISSION' && typeof detail.reason === 'string'
        && /jobs are being opened too quickly|don't retry the same job repeatedly/i.test(detail.reason)) {
        throw new McpJobAccessError(message, {
          jobId: String(input.params?.id ?? '').slice(0, 64), orgUid: String(input.org_uid ?? '').slice(0, 100),
          reason: detail.reason.slice(0, 600), traceId: typeof detail.trace_id === 'string' ? detail.trace_id.slice(0, 100) : null,
        });
      }
      throw new McpToolError(message);
    }
    if (r.structuredContent !== undefined) return r.structuredContent;
    try { return JSON.parse(text); } catch { return text; }
  }
}
