import { emailConfigured, sendEmail } from './email';
import { acquireLease, releaseLease } from './kv';
import { loadSettings, reportEmails, type Env } from './settings';

export async function deliverSafetyAlerts(env: Env): Promise<void> {
  if (!emailConfigured(env)) return;
  const to = reportEmails(await loadSettings(env)); if (!to.length) return;
  const lease = await acquireLease(env, 'notifications', 60_000); if (!lease) return;
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM kv WHERE key LIKE 'notification:%' AND json_extract(value, '$.status') = 'pending' ORDER BY updated_at LIMIT 2").all<{ key: string; value: string }>();
    for (const row of results) {
      const n = JSON.parse(row.value) as { subject: string; text: string };
      await sendEmail(env, to, n.subject, n.text, undefined, row.key);
      await env.DB.prepare("UPDATE kv SET value = json_set(value, '$.status', 'sent'), updated_at = datetime('now') WHERE key = ?").bind(row.key).run();
    }
  } finally { await releaseLease(env, 'notifications', lease); }
}
