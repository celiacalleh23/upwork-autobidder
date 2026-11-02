// Build locally to a temporary directory; never deploy or read production bindings.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { build } from 'esbuild';
const dir = await mkdtemp(join(tmpdir(), 'autobidder-bundle-'));
try {
  await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    loader: { '.html': 'text', '.sql': 'text' }, outfile: join(dir, 'worker.mjs') });
  await build({ entryPoints: ['src/scanner/index.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    loader: { '.html': 'text', '.sql': 'text' }, outfile: join(dir, 'scanner.mjs') });
  const dashboard = await readFile('src/dashboard.html', 'utf8');
  for (const [, script] of dashboard.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script);
  console.log('Both Worker bundles and dashboard JavaScript validated locally.');
} finally { await rm(dir, { recursive: true, force: true }); }
