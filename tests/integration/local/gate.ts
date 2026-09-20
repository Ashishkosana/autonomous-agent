import { describe, vi } from 'vitest';
import {
  ContainerRuntimeError,
  type ContainerRuntimeInfo,
} from '../../../src/sandbox/local/container-runtime.js';
import { DockerCliRuntime } from '../../../src/sandbox/local/docker-cli-runtime.js';
import {
  LocalLinuxEnvironment,
  type LocalLinuxEnvironmentOptions,
} from '../../../src/sandbox/local/local-linux-environment.js';
import { LOCAL_SANDBOX_IMAGE } from '../../../src/sandbox/local/sandbox-spec.js';
import { recordEvidence as record, uniqueId } from '../../support/evidence.js';

/**
 * Gate for tests that need a REAL Docker engine and the built sandbox image.
 *
 * - Default (`npm test`): the suite is SKIPPED unless AGENT_LOCAL_DOCKER=1,
 *   so a developer machine without Docker is not slowed or confused. A fake is
 *   never substituted.
 * - AGENT_REQUIRE_LOCAL_DOCKER=1 (`npm run test:local`): Docker and the image
 *   MUST be present or the file FAILS at load with the exact fix, so the run
 *   that is supposed to prove real execution cannot pass vacuously.
 */
const requested =
  process.env['AGENT_LOCAL_DOCKER'] === '1' || process.env['AGENT_REQUIRE_LOCAL_DOCKER'] === '1';
const required = process.env['AGENT_REQUIRE_LOCAL_DOCKER'] === '1';

export const runtime = new DockerCliRuntime();

async function probe(): Promise<
  { ok: true; info: ContainerRuntimeInfo } | { ok: false; reason: string }
> {
  if (!requested)
    return {
      ok: false,
      reason: 'AGENT_LOCAL_DOCKER=1 not set (run `npm run test:local` to require Docker)',
    };
  try {
    const info = await runtime.info();
    if (info.serverOs !== 'linux')
      return {
        ok: false,
        reason: `Docker engine OS is ${info.serverOs}; Linux containers are required (switch Docker Desktop to Linux containers)`,
      };
    if (!(await runtime.imageExists(LOCAL_SANDBOX_IMAGE)))
      return {
        ok: false,
        reason: `sandbox image ${LOCAL_SANDBOX_IMAGE} not found — build it with \`npm run sandbox:build\``,
      };
    return { ok: true, info };
  } catch (error) {
    const detail =
      error instanceof ContainerRuntimeError ? `${error.kind}: ${error.message}` : String(error);
    return { ok: false, reason: `Docker unavailable — ${detail}` };
  }
}

const gate = await probe();

export const LOCAL_DOCKER_AVAILABLE = gate.ok;
export const DOCKER_INFO: ContainerRuntimeInfo | undefined = gate.ok ? gate.info : undefined;
export const SKIP_REASON = gate.ok ? '' : `local Docker integration NOT RUN — ${gate.reason}`;

if (!gate.ok) {
  if (required) throw new Error(`${SKIP_REASON}. Refusing to pass without real Docker execution.`);
  console.warn(`[skip] ${SKIP_REASON}`);
}

export const describeLocalDocker = describe.skipIf(!gate.ok);

/** Image pulls are done at build time; container start is seconds, but give slow laptops room. */
export function configureIntegrationTimeouts(): void {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
}

export function uniqueContainerName(prefix: string): string {
  return uniqueId(prefix);
}

/** Starts a real disposable sandbox container through the real Docker CLI. */
export function startSandbox(
  prefix: string,
  options: LocalLinuxEnvironmentOptions = {},
): Promise<LocalLinuxEnvironment> {
  if (!gate.ok) throw new Error(SKIP_REASON);
  return LocalLinuxEnvironment.start(runtime, uniqueContainerName(prefix), options);
}

export function recordEvidence(name: string, data: unknown): void {
  record(`local-${name}`, {
    docker: DOCKER_INFO,
    ...(typeof data === 'object' && data ? data : { value: data }),
  });
}
