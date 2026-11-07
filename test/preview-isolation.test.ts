import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { sendEmail } from '../src/email';
import { getAccessToken } from '../src/oauth';
import { PreviewBlocked } from '../src/previewIsolation';
import { environment } from './support/db';

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const uncommented = (s: string) => s.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
const [production, preview] = uncommented(toml).split('[previews.vars]');
const dbs: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); dbs.push(e); return e; };
afterEach(() => { vi.unstubAllGlobals(); dbs.splice(0).forEach((e) => e.sqlite.close()); });

it('keeps production bindings and puts only the empty database under previews', () => {
  expect(production).toContain('database_name = "autobidder"');
  expect(production).toContain('database_id = "77c7e7e7-0532-4a58-b61e-36161370a136"');
  expect(production).toContain('CLAUDE_MODEL = "claude-sonnet-5-5"');
  expect(production).toContain('UPWORK_MCP_URL = "https://mcp.upwork.com/mcp"');
  expect(production).toContain('crons = ["* * * * *", "1-59 * * * *", "3,8,13,18,23,28,33,38,43,48,53,58 * * * *"]');
  expect(production).not.toContain('c8aed43e-50cc-4d79-8f50-fee163b76763');
  expect(production).not.toContain('PREVIEW_ISOLATION');
  expect(preview).toContain('PREVIEW_ISOLATION = "true"');
  expect(preview).toContain('SCAN_ACCOUNT_DISABLED = "true"');
  expect(preview).toContain('CLAUDE_MODEL = "preview-disabled"');
  expect(preview).toContain('UPWORK_MCP_URL = "https://invalid.example"');
  expect(preview).toContain('INDEPENDENT_DRAFTS = "false"');
  expect(preview).toContain('binding = "DB"');
  expect(preview).toContain('database_name = "rafadataapp-pr1-preview"');
  expect(preview).toContain('database_id = "c8aed43e-50cc-4d79-8f50-fee163b76763"');
  expect(preview).not.toContain('77c7e7e7-0532-4a58-b61e-36161370a136');
  expect(preview).not.toMatch(/^\s*\[triggers\]|^\s*crons\s*=|^\s*routes\s*=|^\s*\[\[.*queues|^\s*\[\[.*services|^\s*\[\[.*workflows/m);
  const assigned = toml.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  for (const secret of ['TOKEN_KEY', 'APIFY_TOKEN', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'DASH_PASSWORD', 'INTAKE_SECRET', 'APIFY_WEBHOOK_SECRET']) {
    expect(assigned).not.toContain(`${secret} =`);
  }
});

it('does not run scheduled work or outbound calls when the preview marker is set', async () => {
  const e = { ...env(), PREVIEW_ISOLATION: 'true', ANTHROPIC_API_KEY: 'present', RESEND_API_KEY: 'present', APIFY_TOKEN: 'present' };
  const called = vi.fn();
  vi.stubGlobal('fetch', called);
  await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() } as ScheduledController, e, {} as ExecutionContext);
  await worker.scheduled({ cron: '1-59 * * * *', scheduledTime: Date.now() } as ScheduledController, e, {} as ExecutionContext);
  const webhook = await worker.fetch(new Request('https://preview.example/api/apify-webhook', { method: 'POST', body: '{}' }), e);
  const oauth = await worker.fetch(new Request('https://preview.example/oauth/upwork/start'), e);
  const approve = await worker.fetch(new Request('https://preview.example/api/proposals/1/approve', { method: 'POST', headers: { 'x-dashboard': '1' }, body: '{}' }), e);
  expect(webhook.status).toBe(403);
  expect(oauth.status).toBe(403);
  expect(approve.status).toBe(403);
  expect(called).not.toHaveBeenCalled();
  await expect(getAccessToken(e)).rejects.toBeInstanceOf(PreviewBlocked);
  await expect(sendEmail(e, ['a@example.invalid'], 'subject', 'body')).rejects.toBeInstanceOf(PreviewBlocked);
  expect(called).not.toHaveBeenCalled();
});
