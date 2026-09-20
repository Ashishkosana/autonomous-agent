import { afterAll } from 'vitest';
import type { LocalLinuxEnvironment } from '../../../src/sandbox/local/local-linux-environment.js';
import { describeExecutionEnvironmentContract } from '../../support/execution-environment-contract.js';
import { configureIntegrationTimeouts, describeLocalDocker, startSandbox } from './gate.js';

/**
 * REAL LOCAL LINUX EXECUTION (Docker-gated). The shared ExecutionEnvironment
 * contract suite — the same one the fake and the Cloudflare adapter run —
 * against a real container. One container is shared by the suite.
 */
configureIntegrationTimeouts();

describeLocalDocker('LocalLinuxEnvironment · shared contract suite', () => {
  let shared: LocalLinuxEnvironment | undefined;

  afterAll(async () => {
    await shared?.destroy().catch(() => undefined);
  });

  describeExecutionEnvironmentContract('local-linux (real Docker)', async () => {
    shared ??= await startSandbox('agent-p3b-contract');
    return shared;
  });
});
