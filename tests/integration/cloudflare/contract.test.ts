import { afterAll } from 'vitest';
import { describeExecutionEnvironmentContract } from '../../support/execution-environment-contract.js';
import {
  CLOUDFLARE_CONFIGURED,
  configureIntegrationTimeouts,
  describeCloudflare,
  realSandbox,
  uniqueSandboxId,
  type RealSandbox,
} from './gate.js';

/**
 * REAL CLOUDFLARE EXECUTION (credential-gated). The shared ExecutionEnvironment
 * contract suite — the same one the fake passes — run against a real sandbox.
 */
configureIntegrationTimeouts();

describeCloudflare('Cloudflare Sandbox · shared contract suite', () => {
  let sandbox: RealSandbox | undefined;

  afterAll(async () => {
    await sandbox?.environment.destroy().catch(() => undefined);
  });

  describeExecutionEnvironmentContract('cloudflare-sandbox (real)', async () => {
    if (!CLOUDFLARE_CONFIGURED) throw new Error('not configured');
    sandbox ??= realSandbox(uniqueSandboxId('agent-p3-contract'));
    return sandbox.environment;
  });
});
