import {
  ContainerRuntimeError,
  type ContainerExecOptions,
  type ContainerExecResult,
  type ContainerRuntime,
  type ContainerRuntimeInfo,
  type ContainerSpec,
  type ContainerStatus,
} from '../../src/sandbox/local/container-runtime.js';
import {
  PROCESS_DIR,
  PROCESS_STATUS_SCRIPT,
  START_PROCESS_SCRIPT,
  STOP_PROCESS_SCRIPT,
  WRITE_FILE_SCRIPT,
} from '../../src/sandbox/local/container-scripts.js';

export interface FakeExecCall {
  readonly container: string;
  readonly argv: readonly string[];
  readonly options: ContainerExecOptions;
}

export type FakeShell = (
  command: string,
  stdin: string | undefined,
  options: ContainerExecOptions,
) => ContainerExecResult | Promise<ContainerExecResult>;

interface FakeContainer {
  readonly spec: ContainerSpec;
  status: ContainerStatus;
  readonly files: Map<string, string>;
  readonly directories: Set<string>;
  readonly processes: Map<string, { pid: string; command: string; alive: boolean; exit?: number }>;
}

/**
 * In-memory stand-in for the `ContainerRuntime` port. It recognises the exact
 * argv vectors `LocalLinuxEnvironment` emits (by identity with the constants in
 * `container-scripts.ts`) and emulates their observable behaviour, so the
 * adapter's mapping logic can be unit-tested with NO container engine.
 *
 * Nothing it proves is evidence about Docker or Linux. That evidence comes
 * from `tests/integration/local/` on a machine with Docker, and — for script
 * correctness only — from the namespace runtime on a Linux host.
 */
export class FakeContainerRuntime implements ContainerRuntime {
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Set<string>();
  readonly calls: FakeExecCall[] = [];
  readonly controlLog: string[] = [];
  /** When set, every call throws this error. */
  failWith: ContainerRuntimeError | undefined;
  private pidCounter = 1000;

  constructor(private shell: FakeShell = defaultFakeShell) {}

  setShell(shell: FakeShell): void {
    this.shell = shell;
  }

  async info(): Promise<ContainerRuntimeInfo> {
    this.guard();
    return {
      runtime: 'fake',
      clientVersion: '0.0.0',
      serverVersion: '0.0.0',
      serverOs: 'linux',
      serverArch: 'amd64',
    };
  }

  async imageExists(image: string): Promise<boolean> {
    this.guard();
    this.controlLog.push(`imageExists ${image}`);
    return this.images.has(image);
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    this.guard();
    this.controlLog.push(`create ${spec.name}`);
    if (!this.images.has(spec.image))
      throw new ContainerRuntimeError(`No such image: ${spec.image}`, 'no_such_image');
    if (this.containers.has(spec.name))
      throw new ContainerRuntimeError(
        `Conflict. The container name "${spec.name}" is already in use`,
        'invalid_spec',
      );
    this.containers.set(spec.name, {
      spec,
      status: 'running',
      files: new Map(),
      directories: new Set(['/', '/tmp', spec.workdir]),
      processes: new Map(),
    });
    return `fakeid-${spec.name}`;
  }

  async inspectContainer(name: string): Promise<ContainerStatus | undefined> {
    this.guard();
    this.controlLog.push(`inspect ${name}`);
    return this.containers.get(name)?.status;
  }

  async exec(
    name: string,
    argv: readonly string[],
    options: ContainerExecOptions = {},
  ): Promise<ContainerExecResult> {
    this.guard();
    this.calls.push({ container: name, argv, options });
    const container = this.containers.get(name);
    if (!container)
      throw new ContainerRuntimeError(`No such container: ${name}`, 'no_such_container');
    if (container.status !== 'running')
      throw new ContainerRuntimeError(`container ${name} is not running`, 'container_not_running');
    return this.dispatch(container, argv, options);
  }

  async stopContainer(name: string, timeoutSeconds: number): Promise<void> {
    this.guard();
    this.controlLog.push(`stop ${name} ${timeoutSeconds}`);
    const container = this.containers.get(name);
    if (!container)
      throw new ContainerRuntimeError(`No such container: ${name}`, 'no_such_container');
    container.status = 'exited';
    for (const p of container.processes.values()) p.alive = false;
  }

  async removeContainer(name: string, force: boolean): Promise<void> {
    this.guard();
    this.controlLog.push(`rm ${name} ${force ? 'force' : ''}`.trim());
    const container = this.containers.get(name);
    if (!container)
      throw new ContainerRuntimeError(`No such container: ${name}`, 'no_such_container');
    if (container.status === 'running' && !force)
      throw new ContainerRuntimeError(`cannot remove a running container`, 'invalid_spec');
    this.containers.delete(name);
  }

  /** Test hook: make a background process exit with a code, as if it finished on its own. */
  finishProcess(containerName: string, processId: string, exitCode: number): void {
    const container = this.containers.get(containerName);
    const proc = container?.processes.get(processId);
    if (!container || !proc) throw new Error(`unknown process ${processId}`);
    proc.alive = false;
    proc.exit = exitCode;
    container.files.set(`${PROCESS_DIR}/${processId}/exit`, `${exitCode}\n`);
  }

  private guard(): void {
    if (this.failWith) throw this.failWith;
  }

  private async dispatch(
    c: FakeContainer,
    argv: readonly string[],
    options: ContainerExecOptions,
  ): Promise<ContainerExecResult> {
    const [a0, a1, a2, a3, a4, a5] = argv;

    if (a0 === 'cat' && a1 === '--' && a2 !== undefined) {
      const content = c.files.get(a2);
      if (content === undefined)
        return c.directories.has(a2)
          ? fail(1, `cat: ${a2}: Is a directory\n`)
          : fail(1, `cat: ${a2}: No such file or directory\n`);
      return ok(content);
    }
    if (a0 === 'sh' && a1 === '-c' && a2 === WRITE_FILE_SCRIPT && a4 !== undefined) {
      if (c.directories.has(a4)) return fail(1, `sh: 1: cannot create ${a4}: Is a directory\n`);
      addParents(c.directories, a4);
      c.files.set(a4, options.stdin ?? '');
      return ok('');
    }
    if (a0 === 'rm' && a1 === '--' && a2 !== undefined) {
      if (c.directories.has(a2)) return fail(1, `rm: cannot remove '${a2}': Is a directory\n`);
      if (!c.files.delete(a2))
        return fail(1, `rm: cannot remove '${a2}': No such file or directory\n`);
      return ok('');
    }
    if (a0 === 'test' && a1 === '-e' && a2 !== undefined) {
      return c.files.has(a2) || c.directories.has(a2) ? ok('') : fail(1, '');
    }
    if (a0 === 'find' && a1 !== undefined && a2 === '-mindepth') {
      const dir = a1.endsWith('/') && a1 !== '/' ? a1.slice(0, -1) : a1;
      if (!c.directories.has(dir)) return fail(1, `find: '${dir}': No such file or directory\n`);
      const prefix = dir === '/' ? '/' : `${dir}/`;
      const lines: string[] = [];
      for (const [path, content] of c.files) {
        if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          lines.push(`f\t${Buffer.byteLength(content)}\t${path.slice(prefix.length)}`);
      }
      for (const path of c.directories) {
        if (path !== dir && path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          lines.push(`d\t4096\t${path.slice(prefix.length)}`);
      }
      return ok(lines.map((l) => `${l}\n`).join(''));
    }
    if (
      a0 === 'sh' &&
      a1 === '-c' &&
      a2 === START_PROCESS_SCRIPT &&
      a4 !== undefined &&
      a5 !== undefined
    ) {
      this.pidCounter += 1;
      const pid = String(this.pidCounter);
      c.processes.set(a4, { pid, command: a5, alive: true });
      addParents(c.directories, `${PROCESS_DIR}/${a4}/stdout`);
      return ok(`${pid}\n`);
    }
    if (
      a0 === 'sh' &&
      a1 === '-c' &&
      a2 === PROCESS_STATUS_SCRIPT &&
      a4 !== undefined &&
      a5 !== undefined
    ) {
      const exitFile = c.files.get(a5);
      if (exitFile !== undefined) return ok(`exited ${exitFile.trim()}\n`);
      const proc = [...c.processes.values()].find((p) => p.pid === a4);
      return ok(proc?.alive ? 'running\n' : 'gone\n');
    }
    if (a0 === 'sh' && a1 === '-c' && a2 === STOP_PROCESS_SCRIPT && a4 !== undefined) {
      const proc = [...c.processes.values()].find((p) => p.pid === a4);
      if (!proc || !proc.alive) return fail(3, '');
      proc.alive = false;
      return ok('');
    }
    if (a0 === 'timeout' && a1 === '-k' && a4 === 'sh' && a5 === '-c') {
      const command = argv[6] ?? '';
      const seconds = Number(a3);
      const result = await this.shell(command, options.stdin, options);
      return simulateTimeout(command, seconds, result);
    }
    if (a0 === 'sh' && a1 === '-c' && a2 !== undefined && argv.length === 3) {
      return this.shell(a2, options.stdin, options);
    }
    return fail(127, `fake runtime: unrecognised argv ${JSON.stringify(argv)}\n`);
  }
}

function ok(stdout: string): ContainerExecResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}
function fail(exitCode: number, stderr: string): ContainerExecResult {
  return { exitCode, stdout: '', stderr, timedOut: false };
}

function addParents(directories: Set<string>, filePath: string): void {
  const parts = filePath.split('/').slice(1, -1);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    directories.add(current);
  }
}

/** `sleep N` longer than the deadline behaves like `timeout(1)` firing: exit 124, output so far kept. */
function simulateTimeout(
  command: string,
  seconds: number,
  result: ContainerExecResult,
): ContainerExecResult {
  const sleep = /sleep\s+(\d+(?:\.\d+)?)/.exec(command);
  if (sleep && Number(sleep[1]) > seconds) {
    return { exitCode: 124, stdout: result.stdout, stderr: result.stderr, timedOut: false };
  }
  return result;
}

/** Minimal deterministic "shell" for commands the tests use. */
export function defaultFakeShell(command: string, stdin: string | undefined): ContainerExecResult {
  const printf = /^printf\s+'([^']*)'$/.exec(command);
  if (printf) return ok(printf[1] ?? '');
  const echo = /^echo\s+(.*)$/.exec(command);
  if (echo) return ok(`${(echo[1] ?? '').replace(/^'|'$/g, '')}\n`);
  if (command === 'cat') return ok(stdin ?? '');
  if (command === 'true') return ok('');
  if (command === 'false') return fail(1, '');
  const exit = /^exit\s+(\d+)$/.exec(command);
  if (exit) return fail(Number(exit[1]), '');
  const partialThenSleep = /^printf\s+(\w+);\s*sleep\s+\d+/.exec(command);
  if (partialThenSleep) return ok(partialThenSleep[1] ?? '');
  if (/^sleep\s+[\d.]+$/.test(command)) return ok('');
  return fail(127, `sh: 1: ${command}: not found\n`);
}
