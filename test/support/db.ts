import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Env } from '../../src/settings';

export function environment() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));
  function prepare(sql: string) {
    let args: unknown[] = [];
    const execute = () => {
      const stmt = sqlite.prepare(sql);
      if (stmt.columns().length) return { results: stmt.all(...args as never[]), meta: { changes: 0 } };
      const result = stmt.run(...args as never[]);
      return { results: [], meta: { changes: Number(result.changes) } };
    };
    const q = {
      bind(...values: unknown[]) { args = values; return q; }, execute,
      async first() { return sqlite.prepare(sql).get(...args as never[]) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args as never[]) }; },
      async run() { return execute(); },
    };
    return q;
  }
  const DB = { prepare, async batch(queries: ReturnType<typeof prepare>[]) {
    sqlite.exec('BEGIN');
    try { const results = queries.map(q => q.execute()); sqlite.exec('COMMIT'); return results; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } } as unknown as D1Database;
  return { DB, sqlite, DASH_PASSWORD: 'local-test-password', TOKEN_KEY: 'local-test-key-with-at-least-32-characters', CLAUDE_MODEL: 'mock', UPWORK_MCP_URL: 'https://mock.invalid/mcp' } satisfies Env & { sqlite: DatabaseSync };
}
