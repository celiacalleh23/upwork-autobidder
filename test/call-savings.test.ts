import { afterEach, expect, it, vi } from 'vitest';
import { environment } from './support/db';
import { cachedToolName } from '../src/oauth';
import { runScan, upworkDiscoveryEnabled } from '../src/pipeline/scan';
import { permitSearch } from '../src/upworkPace';
import { getKv, putKv } from '../src/kv';
import { DEFAULT_SETTINGS, patchState, saveSettings } from '../src/settings';

const dbs: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); dbs.push(e); return e; };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); dbs.splice(0).forEach((e) => e.sqlite.close()); });

it('does not call Upwork search when discovery is explicitly off', async () => {
  const e = { ...env(), UPWORK_DISCOVERY: 'false' as const };
  const called = vi.fn(() => { throw new Error('network'); });
  vi.stubGlobal('fetch', called);
  await patchState(e, { paused: false, upwork: { connected: true, orgUid: 'bidding', toolNames: { find_jobs: 'find_jobs' } } });
  await saveSettings(e, { ...structuredClone(DEFAULT_SETTINGS), keywords: ['Klaviyo', 'Email', 'Flows'] });
  await runScan(e, Date.parse('2026-11-07T00:00:00Z'));
  expect(called).not.toHaveBeenCalled();
  expect(await getKv(e, 'discovery:slot')).toBeNull();
});

it('keeps Upwork search on unless discovery is explicitly false', () => {
  expect(upworkDiscoveryEnabled({})).toBe(true);
  expect(upworkDiscoveryEnabled({ UPWORK_DISCOVERY: 'true' })).toBe(true);
  expect(upworkDiscoveryEnabled({ UPWORK_DISCOVERY: 'false' })).toBe(false);
});

it('lists tools once and reuses the names', async () => {
  const e = env();
  const listTools = vi.fn(async () => ['upwork__get_profile', 'list_contracts', 'boost_profile']);
  const client = { listTools };
  expect(await cachedToolName(e, client as never, 'get_profile')).toBe('upwork__get_profile');
  expect(await cachedToolName(e, client as never, 'list_contracts')).toBe('list_contracts');
  expect(await cachedToolName(e, client as never, 'boost_profile')).toBe('boost_profile');
  expect(listTools).toHaveBeenCalledTimes(1);
});

it('does not send another search when the existing search quota is full', async () => {
  const e = env();
  const now = Date.now();
  for (let i = 0; i < 15; i++) await putKv(e, `upwork:search:seed${i}`, String(now));
  await expect(permitSearch(e)).rejects.toThrow('quota');
});
