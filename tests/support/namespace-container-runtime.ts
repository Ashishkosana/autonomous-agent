import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContainerRuntimeError,
  type ContainerExecOptions,
  type ContainerExecResult,
  type ContainerRuntime,
  type ContainerRuntimeInfo,
  type ContainerSpec,
  type ContainerStatus,
} from '../../src/sandbox/local/container-runtime.js';
import { spawnCollect } from '../../src/sandbox/local/docker-cli-runtime.js';

const MARKER = 'AGENT_NS_CONTAINER';

interface NsContainer {
  readonly spec: ContainerSpec;
  readonly workspaceDir: string;
  readonly tmpDir: string;
  status: ContainerStatus;
}

/**
 * TEST-ONLY `ContainerRuntime` that runs the adapter's scripts on the Linux
 * host inside a private user + mount namespace (`unshare -Urm`), with a
 * throw-away directory bind-mounted over the workspace and over `/tmp`.
 *
 * Purpose: prove that `container-scripts.ts` are correct POSIX/GNU shell on a
 * REAL kernel (setsid/kill/timeout/find/cat semantics) without a container
 * engine. It is NOT isolation and NOT Docker: no resource limits, no
 * capability drop, no PID namespace, host root filesystem visible read-only
 * through the mapped user. Evidence from it is labelled accordingly.
 *
 * Every process it starts carries `AGENT_NS_CONTAINER=<name>` so `remove`
 * can find and kill stragglers by scanning /proc — nothing else is touched.
 */
export class NamespaceContainerRuntime implements ContainerRuntime {
  readonly containers = new Map<string, NsContainer>();

  static async available(workspaceRoot = '/workspace'): Promise<string | undefined> {
    if (process.platform !== 'linux') return `not Linux (${process.platform})`;
    if (!existsSync(workspaceRoot)) return `${workspaceRoot} does not exist on this host`;
    try {
      const probe = await spawnCollect(
        'unshare',
        ['-Urm', 'sh', '-c', 'mount -t tmpfs none /tmp && echo ns-ok'],
        { timeoutMs: 10_000 },
      );
      if (probe.exitCode !== 0 || !probe.stdout.includes('ns-ok'))
        return `unshare -Urm unusable: ${probe.stderr.trim() || `exit ${probe.exitCode}`}`;
      return undefined;
    } catch (error) {
      return `unshare unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async info(): Promise<ContainerRuntimeInfo> {
    return {
      runtime: 'linux-namespaces (test-only)',
      clientVersion: 'n/a',
      serverVersion: 'n/a',
      serverOs: process.platform,
      serverArch: process.arch,
    };
  }

  async imageExists(): Promise<boolean> {
    return true;
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    if (this.containers.has(spec.name))
      throw new ContainerRuntimeError(`name in use: ${spec.name}`, 'invalid_spec');
    const base = mkdtempSync(join(tmpdir(), `agent-ns-${spec.name}-`));
    const container: NsContainer = {
      spec,
      workspaceDir: join(base, 'workspace'),
      tmpDir: join(base, 'tmp'),
      status: 'running',
    };
    await spawnCollect('mkdir', ['-p', container.workspaceDir, container.tmpDir], {
      timeoutMs: 5_000,
    });
    this.containers.set(spec.name, container);
    return `ns-${spec.name}`;
  }

  async inspectContainer(name: string): Promise<ContainerStatus | undefined> {
    return this.containers.get(name)?.status;
  }

  async exec(
    name: string,
    argv: readonly string[],
    options: ContainerExecOptions = {},
  ): Promise<ContainerExecResult> {
    const c = this.containers.get(name);
    if (!c) throw new ContainerRuntimeError(`No such container: ${name}`, 'no_such_container');
    if (c.status !== 'running')
      throw new ContainerRuntimeError(`container ${name} is not running`, 'container_not_running');
    const cwd = options.cwd ?? c.spec.workdir;
    const wrapper =
      'ws=$1; wd=$2; tmp=$3; cwd=$4; shift 4; ' +
      'mount --bind "$ws" "$wd" && mount --bind "$tmp" /tmp && cd "$cwd" && exec "$@"';
    const fullArgv = [
      '-Urm',
      'sh',
      '-c',
      wrapper,
      'sh',
      c.workspaceDir,
      c.spec.workdir,
      c.tmpDir,
      cwd,
      ...argv,
    ];
    // The sandbox image ships node on PATH; on the host it may live anywhere
    // (nvm, a daemon directory), so expose the running Node's own directory.
    const nodeDir = process.execPath.slice(0, process.execPath.lastIndexOf('/'));
    const env: Record<string, string> = {
      PATH: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${nodeDir}`,
      HOME: '/tmp',
      LANG: 'C.UTF-8',
      [MARKER]: name,
      ...c.spec.env,
      ...options.env,
    };
    const result = await spawnCollectWithEnv('unshare', fullArgv, env, {
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      timeoutMs: options.timeoutMs ?? 120_000,
    });
    return result;
  }

  async stopContainer(name: string): Promise<void> {
    const c = this.containers.get(name);
    if (!c) throw new ContainerRuntimeError(`No such container: ${name}`, 'no_such_container');
    killMarked(name);
    c.status = 'exited';
  }

  async removeContainer(name: string): Promise<void> {
    const c = this.containers.get(name);
    if (!c) throw new ContainerRuntimeError(`No such container: ${name}`, 'no_such_container');
    killMarked(name);
    rmSync(join(c.workspaceDir, '..'), { recursive: true, force: true });
    this.containers.delete(name);
  }
}

function killMarked(name: string): void {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let environ: string;
    try {
      environ = readFileSync(`/proc/${entry}/environ`, 'latin1');
    } catch {
      continue;
    }
    if (environ.split('\0').includes(`${MARKER}=${name}`)) {
      try {
        process.kill(Number(entry), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

async function spawnCollectWithEnv(
  binary: string,
  args: readonly string[],
  env: Record<string, string>,
  options: { stdin?: string; timeoutMs: number },
): Promise<ContainerExecResult> {
  // `env -i` gives the child exactly `env`, nothing from the test process.
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const result = await spawnCollect('env', ['-i', ...envArgs, binary, ...args], options);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}
