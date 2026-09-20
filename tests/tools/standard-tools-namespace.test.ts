import { afterAll, describe } from 'vitest';
import { LocalLinuxEnvironment } from '../../src/sandbox/local/local-linux-environment.js';
import { recordEvidence } from '../support/evidence.js';
import { NamespaceContainerRuntime } from '../support/namespace-container-runtime.js';
import { describeStandardToolsOnRealLinux } from '../support/standard-tools-real-suite.js';

/**
 * REAL KERNEL, REAL INTERPRETERS, NO CONTAINER ENGINE. The standard tools run
 * through LocalLinuxEnvironment over the test-only namespace runtime: real
 * python3/node/git/curl/coreutils on the host, files in a throw-away
 * directory bind-mounted over /workspace. Proves the tools work on Linux;
 * proves nothing about isolation (that is the Docker suite's job).
 */
const unavailable = await NamespaceContainerRuntime.available();
if (unavailable) console.warn(`[skip] standard tools on real Linux NOT RUN — ${unavailable}`);

const runtime = new NamespaceContainerRuntime();
const opened: LocalLinuxEnvironment[] = [];
let counter = 0;

afterAll(async () => {
  await Promise.all(opened.map((e) => e.destroy().catch(() => undefined)));
});

describe.skipIf(unavailable)('Phase 5 standard tools over Linux namespaces', () => {
  const bundle: Record<string, unknown> = {};
  describeStandardToolsOnRealLinux({
    title: 'Linux namespaces (scripts + interpreters only, no isolation)',
    httpPort: 18731,
    internet: process.env['AGENT_TEST_INTERNET'] === '1',
    async open() {
      counter += 1;
      const env = await LocalLinuxEnvironment.start(runtime, `tools-${process.pid}-${counter}`, {
        defaultCommandTimeoutMs: 60_000,
      });
      opened.push(env);
      return env;
    },
    onEvidence(name, data) {
      bundle[name] = data;
      if (name === 'bundle')
        recordEvidence('namespace-standard-tools', {
          runtime: 'linux-namespaces (test-only)',
          ...bundle,
        });
    },
  });
});
