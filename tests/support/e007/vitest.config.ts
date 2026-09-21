import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Config for the E-007 child process only. The parent test spawns
 * `vitest run --config <this file>` so the child is a genuinely separate OS
 * process running the same TypeScript sources; `child.ts` is deliberately
 * not named `*.test.ts` so the main suite never collects it.
 */
export default defineConfig({
  root: join(import.meta.dirname, '..', '..', '..'),
  test: {
    include: ['tests/support/e007/child.ts'],
    environment: 'node',
  },
});
