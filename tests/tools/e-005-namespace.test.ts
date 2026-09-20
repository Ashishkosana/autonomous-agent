import { afterAll, describe } from 'vitest';
import { LocalLinuxEnvironment } from '../../src/sandbox/local/local-linux-environment.js';
import { describeE005 } from '../support/e005-suite.js';
import { recordEvidence } from '../support/evidence.js';
import { NamespaceContainerRuntime } from '../support/namespace-container-runtime.js';

/** E-005 on the real host kernel through Linux namespaces (real python3; no isolation claimed). */
const unavailable = await NamespaceContainerRuntime.available();
if (unavailable) console.warn(`[skip] E-005 over namespaces NOT RUN — ${unavailable}`);

const runtime = new NamespaceContainerRuntime();
const opened: LocalLinuxEnvironment[] = [];

afterAll(async () => {
  await Promise.all(opened.map((e) => e.destroy().catch(() => undefined)));
});

describe.skipIf(unavailable)('E-005 over Linux namespaces', () => {
  describeE005({
    title: 'Linux namespaces (scripts + python3, no isolation)',
    async open() {
      const env = await LocalLinuxEnvironment.start(runtime, `e005-${process.pid}`, {
        defaultCommandTimeoutMs: 60_000,
      });
      opened.push(env);
      return env;
    },
    onEvidence(data) {
      recordEvidence('namespace-e-005', {
        runtime: 'linux-namespaces (test-only)',
        ...(data as object),
      });
    },
  });
});
