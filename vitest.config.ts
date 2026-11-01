import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [{ name: 'worker-text-bindings', enforce: 'pre', load(id) {
    if (/\.(html|sql)$/.test(id)) return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`;
  } }],
  test: { maxWorkers: 2 },
});
