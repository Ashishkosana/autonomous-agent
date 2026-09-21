import { LocalLinuxEnvironment } from '../../src/sandbox/local/local-linux-environment.js';
import { uniqueId } from './evidence.js';
import { NamespaceContainerRuntime } from './namespace-container-runtime.js';

/**
 * Picks the most real Linux environment this machine can offer for
 * experiments that need actual execution but are not about isolation:
 * Docker when `AGENT_LOCAL_DOCKER=1` and the engine + image exist, otherwise
 * Linux namespaces on the host, otherwise nothing (the caller skips — a fake
 * is never substituted).
 */
export interface RealEnvironmentChoice {
  readonly kind: 'docker' | 'namespaces';
  readonly label: string;
  open(prefix: string): Promise<LocalLinuxEnvironment>;
}

export async function chooseRealEnvironment(): Promise<
  RealEnvironmentChoice | { readonly unavailable: string }
> {
  if (
    process.env['AGENT_LOCAL_DOCKER'] === '1' ||
    process.env['AGENT_REQUIRE_LOCAL_DOCKER'] === '1'
  ) {
    const gate = await import('../integration/local/gate.js');
    if (gate.LOCAL_DOCKER_AVAILABLE) {
      return {
        kind: 'docker',
        label: `Docker ${gate.DOCKER_INFO?.serverVersion ?? ''} (isolated container)`,
        open: (prefix) => gate.startSandbox(prefix),
      };
    }
  }
  const nsUnavailable = await NamespaceContainerRuntime.available();
  if (!nsUnavailable) {
    const runtime = new NamespaceContainerRuntime();
    return {
      kind: 'namespaces',
      label: 'Linux namespaces on the host (real interpreters, no isolation)',
      open: (prefix) =>
        LocalLinuxEnvironment.start(runtime, uniqueId(prefix), { defaultCommandTimeoutMs: 60_000 }),
    };
  }
  return {
    unavailable: `no real Linux environment: Docker not requested/available and ${nsUnavailable}`,
  };
}
