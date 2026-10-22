// Minimal MCP client over Streamable HTTP: initialize → notifications/initialized → tools/list / tools/call.

const PROTOCOL_VERSION = '2025-06-18';

export class McpAuthError extends Error {}
export class McpError extends Error {}
// The tool ran and answered with an error (isError): Upwork gave a definite answer, unlike a dropped connection or 5xx.
export class McpToolError extends McpError {}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

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
  private sessionId: string | null = null;
  private protocol = PROTOCOL_VERSION;
  private nextId = 1;

  constructor(private url: string, private token: string, private timeoutMs = 25_000) {}

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
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params });
    if (!res.ok) throw new McpError(`Upwork MCP ${method} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
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

  // Returns the tool's structured content, or its text parsed as JSON when possible (else the raw text).
  async callTool(name: string, args: object): Promise<unknown> {
    const r = (await this.request('tools/call', { name, arguments: args })) as ToolResult;
    const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (r.isError) throw new McpToolError(`Upwork ${name.replace(/^.*__/, '')}: ${text.slice(0, 300) || 'error'}`);
    if (r.structuredContent !== undefined) return r.structuredContent;
    try { return JSON.parse(text); } catch { return text; }
  }
}
