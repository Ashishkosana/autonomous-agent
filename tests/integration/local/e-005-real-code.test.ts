import { afterAll } from 'vitest';
import type { LocalLinuxEnvironment } from '../../../src/sandbox/local/local-linux-environment.js';
import { describeE005, E005_RESULT_PATH } from '../../support/e005-suite.js';
import {
  configureIntegrationTimeouts,
  describeLocalDocker,
  recordEvidence,
  startSandbox,
} from './gate.js';

/** E-005 inside a real disposable Docker container (Docker-gated; `npm run test:local`). */
configureIntegrationTimeouts();

const opened: LocalLinuxEnvironment[] = [];

afterAll(async () => {
  await Promise.all(opened.map((e) => e.destroy().catch(() => undefined)));
});

describeLocalDocker('E-005 in a real Docker sandbox', () => {
  describeE005({
    title: 'disposable Docker container',
    async open() {
      const env = await startSandbox('agent-e005');
      opened.push(env);
      return env;
    },
    async inspect(env) {
      const owner = await env.runCommand(`stat -c '%U' ${E005_RESULT_PATH}`);
      const python = await env.runCommand('python3 --version');
      return {
        resultOwner: owner.stdout.trim(),
        python: python.stdout.trim() || python.stderr.trim(),
      };
    },
    onEvidence(data) {
      recordEvidence('e-005-real-code', data);
    },
  });
});
