import { afterAll } from 'vitest';
import type { LocalLinuxEnvironment } from '../../../src/sandbox/local/local-linux-environment.js';
import { LOCAL_SANDBOX_USER } from '../../../src/sandbox/local/sandbox-spec.js';
import { describeStandardToolsOnRealLinux } from '../../support/standard-tools-real-suite.js';
import {
  configureIntegrationTimeouts,
  describeLocalDocker,
  recordEvidence,
  startSandbox,
} from './gate.js';

/**
 * Phase 5 tools inside a REAL disposable Docker container (Docker-gated):
 * the same suite as tests/tools/standard-tools-namespace.test.ts, but here
 * the files are owned by the non-root sandbox user, the interpreters are the
 * image's, and the HTTP server/curl traffic stays on the container's own
 * network namespace. Run with `npm run test:local` on a machine with Docker.
 */
configureIntegrationTimeouts();

const opened: LocalLinuxEnvironment[] = [];

afterAll(async () => {
  await Promise.all(opened.map((e) => e.destroy().catch(() => undefined)));
});

describeLocalDocker('Phase 5 standard tools in a real Docker sandbox', () => {
  const bundle: Record<string, unknown> = {};
  describeStandardToolsOnRealLinux({
    title: 'disposable Docker container',
    httpPort: 18731,
    expectFileOwner: LOCAL_SANDBOX_USER,
    internet: process.env['AGENT_TEST_INTERNET'] === '1',
    async open() {
      const env = await startSandbox('agent-tools');
      opened.push(env);
      return env;
    },
    onEvidence(name, data) {
      bundle[name] = data;
      if (name === 'bundle') recordEvidence('standard-tools', bundle);
    },
  });
});
