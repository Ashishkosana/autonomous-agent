import { spawn } from 'node:child_process';
import {
  ExecutionEnvironmentError,
  type CommandOptions,
  type CommandResult,
  type DirectoryEntry,
  type DirectoryEntryType,
  type EnvironmentDescriptor,
  type EnvironmentState,
  type ExecutionEnvironment,
  type ProcessHandle,
  type ProcessState,
} from '../execution-environment.js';
import { ContainerScripts, parseListLine } from '../local/container-scripts.js';

/**
 * Execution environment for a host that cannot start a nested container.
 * Hugging Face Spaces (including free Docker Spaces) do not provide a Docker
 * daemon, so the Space container itself is the Linux the agent runs in.
 *
 * This is not the disposable local-linux sandbox (ADR-002). There is no
 * separate user, no capability drop, no pid/network namespace, and no
 * pinned image. Commands run as the Space user, with a minimal environment
 * that does not inherit the process environment (so a shell cannot print
 * `DATABASE_URL`). File tools are confined to the workspace directory.
 * A shell command can still read other files in the container. Do not put
 * secrets in the image, and do not treat a public Space as an isolated
 * sandbox.
 *
 * The Docker and Cloudflare adapters are unchanged. This one exists so a
 * Space can run the same `ExecutionEnvironment` tools.
 *
 * The default goal and the standard tools speak `/workspace` (the Docker
 * sandbox root). A Space run's real directory is an ephemeral folder under
 * `/tmp`. Paths and shell commands that use `/workspace` are mapped onto
 * that directory, so `file_contains:/workspace/lesson.txt` and `web.fetch`
 * scratch files land in the writable root. A root that is already
 * `/workspace` (or under it) is not remapped.
 */
export const SPACE_PROCESS_PROVIDER = 'space-process';

/** Path the goal, criteria, and standard tools use for the sandbox workspace. */
export const SPACE_WORKSPACE_ALIAS = '/workspace';

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const TIMEOUT_EXIT_CODES: ReadonlySet<number> = new Set([124, 137]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SpaceProcessOptions {
  /** Absolute directory the file tools may touch. Created on start. */
  readonly workspaceRoot: string;
  readonly environmentId: string;
  /** Delete `workspaceRoot` on destroy. Refused unless it is under `/tmp/` or `/workspace/`. */
  readonly ephemeral?: boolean;
  readonly defaultCommandTimeoutMs?: number;
  readonly killGraceSeconds?: number;
  /** PATH for commands. The process environment is never copied. */
  readonly path?: string;
  readonly now?: () => number;
}

interface TrackedProcess {
  readonly processId: string;
  readonly pid: string;
  readonly command: string;
  readonly startedAt: string;
  state: ProcessState;
}

interface SpawnOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export class SpaceProcessEnvironment implements ExecutionEnvironment {
  readonly descriptor: EnvironmentDescriptor;
  private readonly workspaceRoot: string;
  private readonly ephemeral: boolean;
  private readonly defaultCommandTimeoutMs: number;
  private readonly killGraceSeconds: number;
  private readonly pathEnv: string;
  private readonly now: () => number;
  private readonly processes = new Map<string, TrackedProcess>();
  private processCounter = 0;
  private phase: 'running' | 'destroyed' = 'running';

  private constructor(options: SpaceProcessOptions) {
    if (!options.workspaceRoot.startsWith('/')) {
      throw new ExecutionEnvironmentError(
        'space-process: workspaceRoot must be an absolute path',
        'internal',
      );
    }
    this.workspaceRoot = options.workspaceRoot.replace(/\/+$/, '') || '/';
    this.ephemeral = options.ephemeral ?? false;
    this.descriptor = { provider: SPACE_PROCESS_PROVIDER, environmentId: options.environmentId };
    this.defaultCommandTimeoutMs = options.defaultCommandTimeoutMs ?? 60_000;
    this.killGraceSeconds = options.killGraceSeconds ?? 2;
    this.pathEnv = options.path ?? DEFAULT_PATH;
    this.now = options.now ?? Date.now;
  }

  static async start(options: SpaceProcessOptions): Promise<SpaceProcessEnvironment> {
    const env = new SpaceProcessEnvironment(options);
    await env.spawn(['mkdir', '-p', '--', env.workspaceRoot], { timeoutMs: 5_000, cwd: '/' });
    return env;
  }

  async runCommand(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    this.requireRunning();
    const startedAt = this.now();
    const timeoutMs = options.timeoutMs ?? this.defaultCommandTimeoutMs;
    const seconds = Math.max(0.1, timeoutMs / 1000);
    const argv = ContainerScripts.runCommand(
      mapSpaceWorkspaceCommand(this.workspaceRoot, command),
      seconds,
      this.killGraceSeconds,
    );
    const result = await this.spawn(argv, {
      cwd: this.commandCwd(options.cwd),
      env: this.commandEnv(options.env),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      timeoutMs: timeoutMs + this.killGraceSeconds * 1000 + 10_000,
    });
    const durationMs = this.now() - startedAt;
    if (result.timedOut) {
      return {
        command,
        exitCode: null,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
        timedOut: true,
      };
    }
    const timedOut =
      result.exitCode !== null &&
      TIMEOUT_EXIT_CODES.has(result.exitCode) &&
      durationMs >= timeoutMs;
    return {
      command,
      exitCode: timedOut ? null : result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
      timedOut,
    };
  }

  async readFile(path: string): Promise<string> {
    const target = this.confine(path);
    const result = await this.exec(ContainerScripts.readFile(target));
    if (result.exitCode === 0) return result.stdout;
    throw fileError(result, `read ${path}`);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = this.confine(path);
    const result = await this.exec(ContainerScripts.writeFile(target), content);
    if (result.exitCode !== 0) throw fileError(result, `write ${path}`);
  }

  async deleteFile(path: string): Promise<void> {
    const target = this.confine(path);
    const result = await this.exec(ContainerScripts.deleteFile(target));
    if (result.exitCode !== 0) throw fileError(result, `delete ${path}`);
  }

  async fileExists(path: string): Promise<boolean> {
    const target = this.confine(path, { missingOutside: false });
    if (target === undefined) return false;
    const result = await this.exec(ContainerScripts.fileExists(target));
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw fileError(result, `stat ${path}`);
  }

  async listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    const target = this.confine(path);
    const result = await this.exec(ContainerScripts.listDirectory(target));
    if (result.exitCode !== 0) throw fileError(result, `list ${path}`);
    const base = target.endsWith('/') ? target.slice(0, -1) : target;
    const entries: DirectoryEntry[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      const parsed = parseListLine(line);
      if (!parsed) continue;
      entries.push({
        name: parsed.name,
        path: `${base}/${parsed.name}`,
        type: toEntryType(parsed.typeLetter),
        sizeBytes: parsed.size,
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async startProcess(command: string, options: CommandOptions = {}): Promise<ProcessHandle> {
    this.requireRunning();
    this.processCounter += 1;
    const processId = `${this.descriptor.environmentId}-${this.processCounter}`;
    const result = await this.spawn(
      ContainerScripts.startProcess(
        processId,
        mapSpaceWorkspaceCommand(this.workspaceRoot, command),
      ),
      {
        cwd: this.commandCwd(options.cwd),
        env: this.commandEnv(options.env),
        timeoutMs: 15_000,
      },
    );
    const pid = result.stdout.trim();
    if (result.exitCode !== 0 || !/^\d+$/.test(pid)) {
      throw new ExecutionEnvironmentError(
        `space-process: failed to start process: ${result.stderr || `exit ${result.exitCode}`}`,
        'internal',
      );
    }
    const startedAt = new Date(this.now()).toISOString();
    this.processes.set(processId, {
      processId,
      pid,
      command,
      startedAt,
      state: { processId, command, status: 'running' },
    });
    return { processId, command, startedAt };
  }

  async stopProcess(processId: string): Promise<void> {
    this.requireRunning();
    const tracked = this.processes.get(processId);
    if (!tracked) {
      throw new ExecutionEnvironmentError(
        `space-process: unknown process ${processId}`,
        'not_found',
      );
    }
    const result = await this.spawn(
      ContainerScripts.stopProcess(tracked.pid, this.killGraceSeconds * 10),
      { cwd: this.workspaceRoot, env: this.commandEnv(undefined), timeoutMs: 15_000 },
    );
    if (result.exitCode === 3) return;
    if (result.exitCode !== 0) {
      throw new ExecutionEnvironmentError(
        `space-process: failed to stop process ${processId}: ${result.stderr}`,
        'internal',
      );
    }
    tracked.state = { processId, command: tracked.command, status: 'killed' };
  }

  async getState(): Promise<EnvironmentState> {
    if (this.phase === 'running') {
      for (const tracked of this.processes.values()) {
        if (tracked.state.status === 'running') await this.refreshProcess(tracked);
      }
    }
    return {
      descriptor: this.descriptor,
      status: this.phase === 'running' ? 'ready' : 'stopped',
      workspaceRoot: this.workspaceRoot,
      processes: [...this.processes.values()].map((tracked) => tracked.state),
      metadata: {
        provider: SPACE_PROCESS_PROVIDER,
        isolation: 'space-container-boundary',
        nestedDocker: false,
        ephemeral: this.ephemeral,
        note: 'Commands run in this container. A free Hugging Face Space has no nested Docker daemon, so this is not the disposable local-linux sandbox.',
      },
    };
  }

  async destroy(): Promise<void> {
    if (this.phase === 'destroyed') return;
    for (const tracked of this.processes.values()) {
      if (tracked.state.status === 'running') {
        await this.stopProcess(tracked.processId).catch(() => undefined);
      }
    }
    this.phase = 'destroyed';
    if (this.ephemeral) await this.removeWorkspace();
  }

  private async refreshProcess(tracked: TrackedProcess): Promise<void> {
    const result = await this.spawn(
      ContainerScripts.processStatus(tracked.pid, tracked.processId),
      { cwd: this.workspaceRoot, env: this.commandEnv(undefined), timeoutMs: 5_000 },
    );
    const [word, code] = result.stdout.trim().split(/\s+/);
    if (word === 'running') return;
    const exitCode = code !== undefined && /^\d+$/.test(code) ? Number(code) : undefined;
    tracked.state = {
      processId: tracked.processId,
      command: tracked.command,
      status: 'exited',
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }

  private async removeWorkspace(): Promise<void> {
    const root = this.workspaceRoot;
    const dedicated =
      (root.startsWith('/tmp/') || root.startsWith('/workspace/')) &&
      root !== '/tmp' &&
      root !== '/workspace';
    if (!dedicated) {
      throw new ExecutionEnvironmentError(
        'space-process: refusing to delete a workspace that is not a dedicated directory under /tmp or /workspace',
        'internal',
      );
    }
    await this.spawn(['rm', '-rf', '--', root], { timeoutMs: 15_000, cwd: '/' });
  }

  private async exec(argv: readonly string[], stdin?: string): Promise<SpawnOutcome> {
    this.requireRunning();
    return this.spawn(argv, {
      cwd: this.workspaceRoot,
      env: this.commandEnv(undefined),
      ...(stdin !== undefined ? { stdin } : {}),
      timeoutMs: this.defaultCommandTimeoutMs,
    });
  }

  private confine(path: string, options: { missingOutside: false }): string | undefined;
  private confine(path: string, options?: { missingOutside?: true }): string;
  private confine(path: string, options?: { missingOutside?: boolean }): string | undefined {
    const target = mapSpaceWorkspacePath(this.workspaceRoot, path);
    if (target !== undefined) return target;
    if (options?.missingOutside === false) return undefined;
    throw new ExecutionEnvironmentError(
      `space-process: path is outside the workspace: ${path}`,
      'not_found',
    );
  }

  private commandCwd(cwd: string | undefined): string {
    if (cwd === undefined) return this.workspaceRoot;
    return this.confine(cwd);
  }

  private commandEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
    if (env) {
      for (const name of Object.keys(env)) {
        if (!ENV_NAME.test(name)) {
          throw new ExecutionEnvironmentError(
            `space-process: invalid environment variable name ${JSON.stringify(name)}`,
            'internal',
          );
        }
      }
    }
    return {
      PATH: this.pathEnv,
      HOME: '/tmp',
      LANG: 'C.UTF-8',
      ...env,
    };
  }

  private requireRunning(): void {
    if (this.phase !== 'running') {
      throw new ExecutionEnvironmentError(
        'space-process: environment was destroyed',
        'unavailable',
      );
    }
  }

  private spawn(
    argv: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly stdin?: string;
      readonly timeoutMs: number;
    },
  ): Promise<SpawnOutcome> {
    const binary = argv[0];
    if (!binary) {
      return Promise.reject(
        new ExecutionEnvironmentError('space-process: empty command', 'internal'),
      );
    }
    return new Promise((resolve, reject) => {
      const child = spawn(binary, argv.slice(1), {
        cwd: options.cwd ?? this.workspaceRoot,
        env: options.env ?? this.commandEnv(undefined),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(
          new ExecutionEnvironmentError(
            error.code === 'ENOENT'
              ? `space-process: ${binary} was not found. This environment needs a POSIX userland (sh, timeout, find, setsid).`
              : `space-process: failed to spawn ${binary}: ${error.message}`,
            'unavailable',
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
        });
      });
      child.stdin.on('error', () => undefined);
      if (options.stdin !== undefined) child.stdin.end(options.stdin, 'utf8');
      else child.stdin.end();
    });
  }
}

/**
 * Resolve `inputPath` inside `workspaceRoot`. `/workspace` and its children
 * mean the workspace root when that root is not already under `/workspace`.
 * `..` is collapsed before the check, so `/workspace/../etc/passwd` is outside.
 */
export function mapSpaceWorkspacePath(
  workspaceRoot: string,
  inputPath: string,
): string | undefined {
  const workspace = stripTrailingSlash(workspaceRoot);
  const normalized = normaliseAbsolute(inputPath);
  if (normalized === undefined) return undefined;
  const mapped = applyWorkspaceAlias(workspace, normalized);
  if (mapped === workspace || mapped.startsWith(`${workspace}/`)) return mapped;
  return undefined;
}

/**
 * Rewrite `/workspace` path tokens in a shell command onto the real root.
 * `web.fetch` and `http.request` embed that prefix in the curl script. A URL
 * such as `https://example.com/workspace/x` is left alone.
 */
export function mapSpaceWorkspaceCommand(workspaceRoot: string, command: string): string {
  const workspace = stripTrailingSlash(workspaceRoot);
  if (!usesWorkspaceAlias(workspace)) return command;
  return command.replace(
    /(^|[\s"'=<>|;(])\/workspace(?=$|\/|[\s"'`]|$)/g,
    (_match, prefix: string) => `${prefix}${workspace}`,
  );
}

function usesWorkspaceAlias(workspace: string): boolean {
  return workspace !== SPACE_WORKSPACE_ALIAS && !workspace.startsWith(`${SPACE_WORKSPACE_ALIAS}/`);
}

function applyWorkspaceAlias(workspace: string, normalized: string): string {
  if (!usesWorkspaceAlias(workspace)) return normalized;
  if (normalized === SPACE_WORKSPACE_ALIAS) return workspace;
  if (normalized.startsWith(`${SPACE_WORKSPACE_ALIAS}/`)) {
    return `${workspace}${normalized.slice(SPACE_WORKSPACE_ALIAS.length)}`;
  }
  return normalized;
}

function normaliseAbsolute(inputPath: string): string | undefined {
  if (!inputPath.startsWith('/') || inputPath.includes('\0')) return undefined;
  const parts: string[] = [];
  for (const segment of inputPath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

function fileError(result: SpawnOutcome, context: string): ExecutionEnvironmentError {
  const stderr = result.stderr.trim();
  const message = `space-process: failed to ${context}: ${stderr || `exit ${result.exitCode}`}`;
  if (/No such file or directory/i.test(stderr)) {
    return new ExecutionEnvironmentError(message, 'not_found');
  }
  if (/Permission denied/i.test(stderr)) {
    return new ExecutionEnvironmentError(message, 'permission_denied');
  }
  return new ExecutionEnvironmentError(message, 'internal');
}

function toEntryType(letter: string): DirectoryEntryType {
  switch (letter) {
    case 'f':
      return 'file';
    case 'd':
      return 'directory';
    case 'l':
      return 'symlink';
    default:
      return 'other';
  }
}
