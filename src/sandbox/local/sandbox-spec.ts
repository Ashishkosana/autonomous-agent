import type {
  ContainerMount,
  ContainerResourceLimits,
  ContainerSpec,
} from './container-runtime.js';

/**
 * The reproducible sandbox image built from `sandbox/local-linux/Dockerfile`.
 * The tag is pinned here, in the Dockerfile label, and in `package.json`;
 * `tests/sandbox/local-linux-environment.test.ts` asserts they agree.
 */
export const LOCAL_SANDBOX_IMAGE_NAME = 'agent-sandbox-local';
export const LOCAL_SANDBOX_IMAGE_VERSION = '0.1.0';
export const LOCAL_SANDBOX_IMAGE = `${LOCAL_SANDBOX_IMAGE_NAME}:${LOCAL_SANDBOX_IMAGE_VERSION}`;

/** Non-root user baked into the image. */
export const LOCAL_SANDBOX_USER = 'agent';
export const LOCAL_SANDBOX_WORKSPACE = '/workspace';
export const LOCAL_SANDBOX_LABEL = 'agent.sandbox';

/**
 * Development safety limits (ADR-002). They bound a runaway agent, they are
 * not per-action approval gates. Chosen so that `npm install`, `pip install`
 * and small builds work while a fork bomb or memory leak cannot take the host.
 */
export const DEFAULT_LOCAL_SANDBOX_LIMITS: ContainerResourceLimits = {
  cpus: 2,
  memory: '2g',
  pidsLimit: 256,
};

/** Per-command wall-clock ceiling applied when a caller passes no `timeoutMs`. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;

/**
 * Environment variable names the sandbox init process receives. Nothing from
 * the host process environment is ever forwarded; values are fixed here.
 */
export const LOCAL_SANDBOX_ENV: Readonly<Record<string, string>> = {
  LANG: 'C.UTF-8',
  PYTHONUNBUFFERED: '1',
  AGENT_SANDBOX: 'local-linux',
};

/**
 * Host paths that may never be mounted, whatever the caller asks for. Matching
 * is by normalised prefix, case-insensitive on Windows-style paths.
 */
export const FORBIDDEN_MOUNT_SOURCES: readonly string[] = [
  '/',
  '/etc',
  '/root',
  '/home',
  '/var/run/docker.sock',
  '/run/docker.sock',
  '//./pipe/docker_engine',
  'C:\\',
  'C:\\Users',
  'C:\\Windows',
  'C:\\ProgramData\\Docker',
];

export interface LocalSandboxOptions {
  readonly image?: string;
  readonly user?: string;
  readonly workspaceRoot?: string;
  readonly network?: 'bridge' | 'none';
  readonly limits?: Partial<ContainerResourceLimits>;
  /** Explicit, reviewed host mounts. Empty by default: sandbox state is disposable. */
  readonly mounts?: readonly ContainerMount[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly stopTimeoutSeconds?: number;
}

export class MountPolicyViolation extends Error {
  constructor(
    readonly mount: ContainerMount,
    reason: string,
  ) {
    super(`refusing to mount ${mount.source} → ${mount.target}: ${reason}`);
    this.name = 'MountPolicyViolation';
  }
}

export function validateMount(mount: ContainerMount): void {
  const source = normaliseHostPath(mount.source);
  if (source === '') throw new MountPolicyViolation(mount, 'source must be an absolute path');
  for (const forbidden of FORBIDDEN_MOUNT_SOURCES) {
    const f = normaliseHostPath(forbidden);
    if (source === f) throw new MountPolicyViolation(mount, `${forbidden} is never mounted`);
    // Mounting a *parent* of a forbidden path exposes the forbidden path too.
    if (f.startsWith(`${source}/`) && source !== '/')
      throw new MountPolicyViolation(mount, `${forbidden} would be exposed`);
  }
  if (/^\/(home|Users)\/[^/]+\/?$/.test(source) || /^[a-z]:\/users\/[^/]+\/?$/i.test(source))
    throw new MountPolicyViolation(mount, 'a whole user home directory is never mounted');
  if (!mount.target.startsWith('/'))
    throw new MountPolicyViolation(mount, 'target must be absolute');
}

function normaliseHostPath(path: string): string {
  let p = path.trim().replace(/\\/g, '/');
  if (/^[a-z]:/i.test(p)) p = p[0]!.toUpperCase() + p.slice(1);
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

export function buildContainerSpec(name: string, options: LocalSandboxOptions = {}): ContainerSpec {
  const mounts = options.mounts ?? [];
  for (const mount of mounts) validateMount(mount);
  const network = options.network ?? 'bridge';
  return {
    image: options.image ?? LOCAL_SANDBOX_IMAGE,
    name,
    user: options.user ?? LOCAL_SANDBOX_USER,
    workdir: options.workspaceRoot ?? LOCAL_SANDBOX_WORKSPACE,
    network,
    limits: { ...DEFAULT_LOCAL_SANDBOX_LIMITS, ...options.limits },
    dropAllCapabilities: true,
    noNewPrivileges: true,
    init: true,
    env: LOCAL_SANDBOX_ENV,
    labels: { [LOCAL_SANDBOX_LABEL]: '1', ...options.labels },
    mounts,
    command: ['sleep', 'infinity'],
    stopTimeoutSeconds: options.stopTimeoutSeconds ?? 5,
  };
}
