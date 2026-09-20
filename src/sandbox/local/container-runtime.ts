/**
 * ContainerRuntime is the local-provider port: the small subset of a container
 * engine that `LocalLinuxEnvironment` needs. It is deliberately shaped like
 * "docker run / docker exec / docker inspect / docker stop / docker rm" but
 * contains no Docker code, so it can be implemented by the Docker CLI
 * (`DockerCliRuntime`), by an in-memory fake, or by a namespace-based
 * emulation used to validate the shell scripts on a plain Linux host.
 *
 * The runtime is the TRUSTED OUTER CONTROLLER. The agent never receives a
 * `ContainerRuntime`; it only receives an `ExecutionEnvironment`.
 */

export interface ContainerMount {
  /** Absolute host path. Validated against `FORBIDDEN_MOUNT_SOURCES` by the environment. */
  readonly source: string;
  /** Absolute path inside the container. */
  readonly target: string;
  readonly readOnly: boolean;
}

export interface ContainerResourceLimits {
  /** Fractional CPUs, e.g. 2 → `--cpus 2`. */
  readonly cpus: number;
  /** Memory limit, e.g. "2g". Swap is pinned to the same value (no swap). */
  readonly memory: string;
  /** Maximum number of processes/threads inside the container. */
  readonly pidsLimit: number;
}

export interface ContainerSpec {
  readonly image: string;
  readonly name: string;
  /** User (name or uid[:gid]) the init process and every exec run as. */
  readonly user: string;
  readonly workdir: string;
  /** Network mode. Only `bridge` (isolated namespace, outbound allowed) and `none` are permitted. */
  readonly network: 'bridge' | 'none';
  readonly limits: ContainerResourceLimits;
  /** `--cap-drop ALL` when true. */
  readonly dropAllCapabilities: boolean;
  /** `--security-opt no-new-privileges` when true. */
  readonly noNewPrivileges: boolean;
  /** Run a minimal init (`--init`) so orphaned background processes are reaped. */
  readonly init: boolean;
  /** Environment visible to the init process and inherited by execs. Names only from an allow-list. */
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly mounts: readonly ContainerMount[];
  /** Init command; the sandbox idles on it (e.g. `sleep infinity`). */
  readonly command: readonly string[];
  /** Seconds `stop` waits for the init process before SIGKILL. */
  readonly stopTimeoutSeconds: number;
}

export type ContainerStatus =
  'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';

export interface ContainerExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  /**
   * Host-side backstop: how long the runtime waits for the exec client before
   * giving up. The environment enforces real deadlines INSIDE the container
   * with `timeout(1)`; this only protects against a hung engine.
   */
  readonly timeoutMs?: number;
}

export interface ContainerExecResult {
  /** `null` when the exec client was killed by the host-side backstop. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ContainerRuntimeInfo {
  readonly runtime: string;
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly serverOs: string;
  readonly serverArch: string;
}

export interface ContainerRuntime {
  /** Engine identity; throws `ContainerRuntimeError('engine_unavailable')` when unreachable. */
  info(): Promise<ContainerRuntimeInfo>;
  imageExists(image: string): Promise<boolean>;
  /** Creates AND starts a detached container; returns the engine's container id. */
  createContainer(spec: ContainerSpec): Promise<string>;
  /** `undefined` when no container of that name exists. */
  inspectContainer(name: string): Promise<ContainerStatus | undefined>;
  exec(
    name: string,
    argv: readonly string[],
    options?: ContainerExecOptions,
  ): Promise<ContainerExecResult>;
  stopContainer(name: string, timeoutSeconds: number): Promise<void>;
  removeContainer(name: string, force: boolean): Promise<void>;
}

export type ContainerRuntimeErrorKind =
  /** CLI missing or daemon unreachable. */
  | 'engine_unavailable'
  | 'no_such_container'
  | 'container_not_running'
  | 'no_such_image'
  | 'invalid_spec'
  | 'unknown';

export class ContainerRuntimeError extends Error {
  constructor(
    message: string,
    readonly kind: ContainerRuntimeErrorKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ContainerRuntimeError';
  }
}
