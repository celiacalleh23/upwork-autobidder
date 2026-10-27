import { dayStartUtc, postedIso } from '../api';
import { emailConfigured, esc, sendEmail } from '../email';
import { getKv, putKv } from '../kv';
import { loadSettings, loadState, reportEmails, type Env, type Settings } from '../settings';

// Daily report (M7): one email a day at settings.report.hour in the Settings time zone (Siv: 3 pm California), with
// what was sent that day (title, Connects, speed), what waits, what failed, and the account's state.

export interface SentRow { title: string; url: string | null; submittedAt: string; postedAt: string | null; connects: number | null; bid: number | null; jobType: string | null; loomUrl: string | null; boost?: number | null }
export interface Problem { title: string; url: string | null; status: string; error: string | null }
export interface ReportData {
  dateLabel: string; timeZone: string; now: string;
  sent: SentRow[]; failed: Problem[];
  waiting: number; approved: number; scanned: number; matched: number;
  balance: number | null; alertBelow: number;
  mode: string; sendingEnabled: boolean; paused: string | null;
  loom: { connected: boolean; expiresAt: string | null };
}

const LAST_KEY = 'report:lastDate';
// Upwork sells Connects at $0.15 each (Oct 2026); the dashboard uses the same rate.
export const CONNECT_USD = 0.15;
const usd = (connects: number) => `$${(connects * CONNECT_USD).toFixed(2)}`;

// "2026-10-26" and the hour (0–23) in the given time zone.
export function localDay(timeZone: string, now = new Date()): { date: string; hour: number; label: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const label = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(now);
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), label };
}

// Whether the cron should send today's report now.
export function reportDue(s: Settings, lastDate: string | null, now = new Date()): boolean {
  const d = localDay(s.caps.timezone, now);
  return d.hour >= s.report.hour && lastDate !== d.date;
}

const minutes = (from: string | null, to: string) => {
  if (!from) return null;
  const m = Math.round((Date.parse(to) - Date.parse(from)) / 60000);
  return Number.isFinite(m) && m >= 0 ? m : null;
};
const durText = (m: number | null) => (m === null ? '–' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);
const toIso = (s: string) => `${s.replace(' ', 'T')}${s.endsWith('Z') ? '' : 'Z'}`;

export function buildReport(d: ReportData): { subject: string; text: string; html: string } {
  const time = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: d.timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const spent = d.sent.reduce((t, r) => t + (r.connects ?? 0), 0);
  // Boost bids are charged only when the proposal lands in a paid slot, so they are shown apart from the Connects spent.
  const boosted = d.sent.filter((r) => r.boost);
  const boostBids = boosted.reduce((t, r) => t + (r.boost ?? 0), 0);
  const boostLine = boosted.length ? `Boosted: ${boosted.length} · boost bids ${boostBids} Connects (${usd(boostBids)}), charged only for proposals that land in a paid slot` : null;
  const speeds = d.sent.map((r) => minutes(r.postedAt, r.submittedAt)).filter((m): m is number => m !== null).sort((a, b) => a - b);
  const median = speeds.length ? speeds[Math.floor(speeds.length / 2)] : null;
  const subject = `Upwork report ${d.dateLabel}: ${d.sent.length} sent, ${spent} Connects (${usd(spent)})`;
  const status = [
    d.paused ? `PAUSED: ${d.paused}` : d.sendingEnabled ? 'Sending is on' : 'Sending is off',
    `Mode: ${d.mode === 'auto' ? 'Auto-submit' : 'Review first'}`,
    `Connects balance: ${d.balance ?? 'unknown'}${d.balance !== null && d.alertBelow && d.balance < d.alertBelow ? ` (below ${d.alertBelow}, buy more)` : ''}`,
    `Loom: ${d.loom.connected ? `connected${d.loom.expiresAt ? `, session valid until ${new Date(d.loom.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}` : 'NOT connected (letters use the source video)'}`,
  ];
  const sentLines = d.sent.map((r) => `- ${time(r.submittedAt)} · ${r.title} · ${r.connects ?? '?'} Connects (${usd(r.connects ?? 0)})${r.boost ? ` + ${r.boost} boost bid` : ''} · bid $${r.bid ?? '?'}${r.jobType === 'hourly' ? '/hr' : ''} · ${durText(minutes(r.postedAt, r.submittedAt))} after posting${r.url ? `\n  ${r.url}` : ''}`);
  const failLines = d.failed.map((r) => `- ${r.title}: ${r.error ?? r.status}`);
  const text = [
    `Upwork Auto-Bidder, ${d.dateLabel} (so far, ${time(d.now)})`, '',
    `Sent today: ${d.sent.length} · Connects spent: ${spent} (${usd(spent)} at $${CONNECT_USD.toFixed(2)} each)${median !== null ? ` · median speed: ${durText(median)} after posting` : ''}`,
    ...(boostLine ? [boostLine] : []),
    `Jobs scanned: ${d.scanned} (${d.matched} matched) · waiting for review: ${d.waiting} · approved, sending soon: ${d.approved}`, '',
    ...status, '',
    d.sent.length ? 'Proposals sent:' : 'No proposals sent today.', ...sentLines,
    ...(failLines.length ? ['', 'Needs a look:', ...failLines] : []),
    '', 'Upwork Auto-Bidder',
  ].join('\n');

  const cell = 'padding:8px 10px;border-bottom:1px solid #e5e7e3;vertical-align:top;font-size:14px';
  const rows = d.sent.map((r) => `<tr><td style="${cell};white-space:nowrap">${esc(time(r.submittedAt))}</td><td style="${cell}">${r.url ? `<a href="${esc(r.url)}" style="color:#1F5F4F">${esc(r.title)}</a>` : esc(r.title)}${r.loomUrl ? `<br><a href="${esc(r.loomUrl)}" style="color:#5B615A;font-size:12px">Loom</a>` : ''}</td><td style="${cell};text-align:right;white-space:nowrap">${r.connects ?? '–'}${r.connects ? `<br><span style="color:#5B615A;font-size:12px">${usd(r.connects)}</span>` : ''}${r.boost ? `<br><span style="color:#5B615A;font-size:12px">+${r.boost} boost bid</span>` : ''}</td><td style="${cell};text-align:right;white-space:nowrap">$${r.bid ?? '–'}${r.jobType === 'hourly' ? '/hr' : ''}</td><td style="${cell};white-space:nowrap">${esc(durText(minutes(r.postedAt, r.submittedAt)))}</td></tr>`).join('');
  const tile = (label: string, value: string, sub = '') => `<td style="padding:12px 14px;border:1px solid #e5e7e3;border-radius:10px;background:#fff"><div style="font-size:12px;color:#5B615A">${esc(label)}</div><div style="font-size:22px;font-weight:700;margin-top:2px">${esc(value)}</div>${sub ? `<div style="font-size:13px;font-weight:600;margin-top:2px">${esc(sub)}</div>` : ''}</td>`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#16181D;background:#F3F4F2;padding:20px">
<div style="max-width:680px;margin:0 auto">
<h1 style="font-size:20px;margin:0 0 4px">Upwork report · ${esc(d.dateLabel)}</h1>
<p style="margin:0 0 16px;color:#5B615A;font-size:14px">So far today, at ${esc(time(d.now))}${d.paused ? ` · <b style="color:#8A2A15">PAUSED: ${esc(d.paused)}</b>` : ''}</p>
<table role="presentation" style="border-collapse:separate;border-spacing:8px;margin:0 -8px 8px"><tr>${tile('Sent today', String(d.sent.length))}${tile('Connects spent', String(spent), usd(spent))}${tile('Median speed', median === null ? '–' : durText(median))}${tile('Connects left', d.balance === null ? '–' : String(d.balance))}</tr></table>
${boostLine ? `<p style="font-size:14px;margin:0 0 6px">${esc(boostLine)}</p>` : ''}
<p style="font-size:14px;margin:0 0 6px">Jobs scanned: <b>${d.scanned}</b> (${d.matched} matched) · Waiting for review: <b>${d.waiting}</b> · Approved, sending soon: <b>${d.approved}</b></p>
<p style="font-size:14px;margin:0 0 16px;color:#5B615A">${status.map(esc).join(' · ')}</p>
${d.sent.length ? `<table style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #e5e7e3;border-radius:10px"><thead><tr>${['Sent', 'Job', 'Connects', 'Bid', 'After posting'].map((h) => `<th style="${cell};text-align:left;font-size:12px;color:#5B615A">${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>` : '<p style="font-size:14px">No proposals sent today.</p>'}
${d.failed.length ? `<h2 style="font-size:15px;margin:18px 0 6px">Needs a look</h2><ul style="margin:0;padding-left:18px;font-size:14px">${d.failed.map((r) => `<li>${esc(r.title)}: ${esc(r.error ?? r.status)}</li>`).join('')}</ul>` : ''}
<p style="font-size:12px;color:#5B615A;margin-top:20px">Upwork Auto-Bidder · times in ${esc(d.timeZone)} · Connects at $${CONNECT_USD.toFixed(2)} each</p>
</div></div>`;
  return { subject, text, html };
}

export async function collectReport(env: Env, s: Settings, now = new Date()): Promise<ReportData> {
  const st = await loadState(env);
  const since = dayStartUtc(s.caps.timezone, now);
  const [sent, failed, counts, jobs] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT title, url, submitted_at, connects, boost_connects, bid, job_type, loom_url, (SELECT posted_at FROM jobs WHERE jobs.id = proposals.job_id) AS posted_at
       FROM proposals WHERE status = 'submitted' AND submitted_at >= ? AND is_example = 0 ORDER BY submitted_at`,
    ).bind(since),
    env.DB.prepare(
      `SELECT title, url, status, error FROM proposals WHERE status IN ('failed', 'unknown') AND COALESCE(submitted_at, created_at) >= ? AND is_example = 0 ORDER BY id LIMIT 20`,
    ).bind(since),
    env.DB.prepare("SELECT SUM(status = 'pending') AS waiting, SUM(status = 'approved') AS approved FROM proposals WHERE is_example = 0"),
    env.DB.prepare("SELECT COUNT(*) AS scanned, SUM(status IN ('matched', 'low_score', 'proposed')) AS matched FROM jobs WHERE seen_at >= ?").bind(since),
  ]);
  const c = counts.results[0] ?? {}, j = jobs.results[0] ?? {};
  return {
    dateLabel: localDay(s.caps.timezone, now).label, timeZone: s.caps.timezone, now: now.toISOString(),
    sent: sent.results.map((r) => ({
      title: String(r.title), url: (r.url as string) ?? null, submittedAt: toIso(String(r.submitted_at)), postedAt: postedIso((r.posted_at as string) ?? null),
      connects: (r.connects as number) ?? null, bid: (r.bid as number) ?? null, jobType: (r.job_type as string) ?? null, loomUrl: (r.loom_url as string) ?? null,
      boost: (r.boost_connects as number) ?? null,
    })),
    failed: failed.results.map((r) => ({ title: String(r.title), url: (r.url as string) ?? null, status: String(r.status), error: (r.error as string) ?? null })),
    waiting: Number(c.waiting ?? 0), approved: Number(c.approved ?? 0), scanned: Number(j.scanned ?? 0), matched: Number(j.matched ?? 0),
    balance: st.connectsBalance, alertBelow: s.connectsAlertBelow,
    mode: st.mode, sendingEnabled: s.sendingEnabled, paused: st.paused ? (st.pausedReason ?? 'from the dashboard') : null,
    loom: { connected: st.loom.connected, expiresAt: st.loom.expiresAt },
  };
}

// Sends today's report. `force` (the dashboard's "Send test report") sends now and does not count as today's report.
export async function sendDailyReport(env: Env, opts: { force?: boolean; now?: Date } = {}): Promise<{ sent: boolean; to: string[] }> {
  const now = opts.now ?? new Date();
  const s = await loadSettings(env);
  const to = reportEmails(s);
  if (!opts.force && !reportDue(s, await getKv(env, LAST_KEY), now)) return { sent: false, to };
  if (!emailConfigured(env)) { if (opts.force) throw new Error('Add the RESEND_API_KEY secret in Cloudflare first.'); return { sent: false, to }; }
  if (!to.length) { if (opts.force) throw new Error('Add a report email in Settings → Reports and connections, then save.'); return { sent: false, to }; }
  const r = buildReport(await collectReport(env, s, now));
  await sendEmail(env, to, opts.force ? `[Test] ${r.subject}` : r.subject, r.text, r.html);
  if (!opts.force) await putKv(env, LAST_KEY, localDay(s.caps.timezone, now).date);
  return { sent: true, to };
}
