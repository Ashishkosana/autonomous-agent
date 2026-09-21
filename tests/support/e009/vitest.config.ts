import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Config for the E-009 child process only (see E-007 for the pattern). The
 * parent spawns `vitest run --config <this file>`; `child.ts` is deliberately
 * not named `*.test.ts` so the main suite never collects it.
 */
export default defineConfig({
  root: join(import.meta.dirname, '..', '..', '..'),
  test: {
    include: ['tests/support/e009/child.ts'],
    environment: 'node',
  },
});
