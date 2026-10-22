import type { Env } from './settings';

// Email through Resend (BUILD_PLAN M7). Without RESEND_API_KEY nothing is sent and the caller shows the message on the
// dashboard instead. REPORT_FROM must be an address on a domain verified in Resend; Resend's test sender only delivers
// to the Resend account's own email.

export const emailConfigured = (env: Env) => Boolean(env.RESEND_API_KEY);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export async function sendEmail(env: Env, to: string[], subject: string, text: string): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set.');
  const recipients = to.map((t) => t.trim()).filter(Boolean);
  if (!recipients.length) throw new Error('No report email set in Settings.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.REPORT_FROM || 'Upwork Auto-Bidder <onboarding@resend.dev>',
      to: recipients,
      subject,
      text,
      html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${esc(text).replace(/\n/g, '<br>')}</div>`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Resend refused the email (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
