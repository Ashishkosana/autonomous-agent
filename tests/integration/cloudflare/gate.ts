import { describe, vi } from 'vitest';
import { CloudflareSandboxEnvironment } from '../../../src/sandbox/cloudflare/cloudflare-sandbox-environment.js';
import { readGatewayConfig } from '../../../src/sandbox/cloudflare/config.js';
import { HttpSandboxClient } from '../../../src/sandbox/cloudflare/http-sandbox-client.js';
import { recordEvidence as record, uniqueId } from '../../support/evidence.js';

/**
 * Gate for tests that need REAL Cloudflare infrastructure (a deployed gateway
 * Worker in front of Cloudflare Sandbox).
 *
 * - Not configured → every `describeCloudflare` block is SKIPPED and vitest
 *   reports it as skipped; a fake is never substituted.
 * - `AGENT_REQUIRE_CLOUDFLARE=1` (used by `npm run test:cloudflare`) and not
 *   configured → the file FAILS at load, so a CI job meant to prove Cloudflare
 *   cannot pass vacuously.
 *
 * Only variable NAMES are ever printed.
 */
const gate = readGatewayConfig(process.env);

export const CLOUDFLARE_CONFIGURED = gate.configured;
export const SKIP_REASON = gate.configured
  ? ''
  : `Cloudflare integration NOT RUN — missing environment variables: ${gate.missing.join(', ')}`;

if (!gate.configured) {
  if (process.env['AGENT_REQUIRE_CLOUDFLARE'] === '1') {
    throw new Error(`${SKIP_REASON}. Refusing to pass without real Cloudflare access.`);
  }
  console.warn(`[skip] ${SKIP_REASON}`);
}

/** `describe` that is skipped (visibly) when Cloudflare is not configured. */
export const describeCloudflare = describe.skipIf(!gate.configured);

/** Cold container starts can take well over a minute; give every hook and test room. */
export function configureIntegrationTimeouts(): void {
  vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });
}

export function uniqueSandboxId(prefix: string): string {
  return uniqueId(prefix);
}

export interface RealSandbox {
  readonly sandboxId: string;
  readonly client: HttpSandboxClient;
  readonly environment: CloudflareSandboxEnvironment;
}

/** Builds the real adapter stack: CloudflareSandboxEnvironment → HttpSandboxClient → gateway Worker → Cloudflare Sandbox. */
export function realSandbox(sandboxId: string): RealSandbox {
  if (!gate.configured) throw new Error(SKIP_REASON);
  const client = new HttpSandboxClient({ ...gate.config, sandboxId });
  return { sandboxId, client, environment: new CloudflareSandboxEnvironment(client) };
}

/** Evidence lives outside the repository; see tests/support/evidence.ts. */
export function recordEvidence(name: string, data: unknown): void {
  record(`cloudflare-${name}`, data);
}
