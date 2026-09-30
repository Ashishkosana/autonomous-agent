/**
 * Gate for tests that need a real Postgres database (Neon, or any Postgres
 * that speaks the same wire protocol).
 *
 * - Not configured → the suite is skipped and a warning names the variables.
 * - `AGENT_REQUIRE_NEON=1` (`npm run test:neon`, `npm run experiment:e010`)
 *   and not configured → the file fails at load.
 *
 * `deleteAll()` truncates every agent table. Point these tests at a
 * dedicated database or Neon branch, not a database you care about.
 */
const url =
  clean(process.env['AGENT_MEMORY_URL']) ??
  clean(process.env['NEON_DATABASE_URL']) ??
  clean(process.env['DATABASE_URL']);

const missing = ['AGENT_MEMORY_URL or NEON_DATABASE_URL or DATABASE_URL'];

export const NEON_CONFIGURED = url !== undefined;
export const NEON_URL = url;
export const SKIP_REASON = url
  ? ''
  : `Neon integration NOT RUN — missing environment variables: ${missing.join(', ')}`;

if (!url) {
  if (process.env['AGENT_REQUIRE_NEON'] === '1') {
    throw new Error(`${SKIP_REASON}. Refusing to pass without a Postgres connection string.`);
  }
  console.warn(`[skip] ${SKIP_REASON}`);
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
