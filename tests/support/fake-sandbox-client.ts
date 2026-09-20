import {
  SandboxClientError,
  type SandboxClient,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxFileEntry,
  type SandboxInfo,
  type SandboxProcessRecord,
  type SandboxStartProcessOptions,
} from '../../src/sandbox/cloudflare/sandbox-client.js';

export interface FakeSandboxCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

export type FakeCommandScript = (
  command: string,
  stdin: string | undefined,
  options: SandboxExecOptions | undefined,
) => Promise<SandboxExecResult> | SandboxExecResult;

/**
 * In-memory stand-in for the Cloudflare-shaped `SandboxClient` port. It is
 * used to unit test `CloudflareSandboxEnvironment`'s mapping logic and the
 * gateway's routing WITHOUT any Cloudflare infrastructure. Nothing it proves
 * counts as evidence about Cloudflare itself.
 *
 * It understands the two shell wrappers the adapter emits (`timeout … sh -c`
 * and `sh -c … < file`) so tests can assert on the adapter's behaviour rather
 * than on string concatenation.
 */
export class FakeSandboxClient implements SandboxClient {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>(['/', '/workspace', '/tmp']);
  readonly processes = new Map<string, SandboxProcessRecord>();
  readonly calls: FakeSandboxCall[] = [];
  destroyed = false;
  /** When set, every call throws this error (simulates an unavailable container etc.). */
  failWith: SandboxClientError | undefined;
  private processCounter = 0;

  constructor(
    readonly sandboxId = 'fake-sandbox',
    private script: FakeCommandScript = defaultFakeScript,
  ) {}

  setCommandScript(script: FakeCommandScript): void {
    this.script = script;
  }

  async exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult> {
    this.record('exec', command, options);
    const unwrapped = unwrapAdapterShell(command);
    let stdin: string | undefined;
    if (unwrapped.stdinPath !== undefined) {
      stdin = this.files.get(unwrapped.stdinPath);
      if (stdin === undefined) {
        throw new SandboxClientError(
          `stdin file missing: ${unwrapped.stdinPath}`,
          'file_not_found',
        );
      }
    }
    const result = await this.script(unwrapped.command, stdin, options);
    if (unwrapped.timeoutSeconds !== undefined) {
      const sleep = /^sleep\s+([\d.]+)$/.exec(unwrapped.command);
      if (sleep && Number(sleep[1]) > unwrapped.timeoutSeconds) {
        await new Promise((r) => setTimeout(r, unwrapped.timeoutSeconds! * 1000));
        return { exitCode: 124, stdout: '', stderr: '' };
      }
    }
    return result;
  }

  async startProcess(
    command: string,
    options?: SandboxStartProcessOptions,
  ): Promise<SandboxProcessRecord> {
    this.record('startProcess', command, options);
    this.processCounter += 1;
    const record: SandboxProcessRecord = {
      id: `proc-${this.processCounter}`,
      pid: 1000 + this.processCounter,
      command,
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    this.processes.set(record.id, record);
    return record;
  }

  async listProcesses(): Promise<readonly SandboxProcessRecord[]> {
    this.record('listProcesses');
    return [...this.processes.values()];
  }

  async killProcess(processId: string, signal?: string): Promise<void> {
    this.record('killProcess', processId, signal);
    const record = this.processes.get(processId);
    if (!record) throw new SandboxClientError(`no process ${processId}`, 'process_not_found');
    this.processes.set(processId, { ...record, status: 'killed', exitCode: 143 });
  }

  /** Simulates the sandbox dropping the record of a finished process. */
  forgetProcess(processId: string): void {
    this.processes.delete(processId);
  }

  async readFile(path: string): Promise<string> {
    this.record('readFile', path);
    const content = this.files.get(path);
    if (content === undefined) {
      throw new SandboxClientError(`ENOENT ${path}`, 'file_not_found', {
        sdkErrorName: 'FileNotFoundError',
      });
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.record('writeFile', path, content);
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    if (!this.directories.has(parent)) {
      throw new SandboxClientError(`parent missing ${parent}`, 'file_not_found', {
        sdkErrorName: 'FileNotFoundError',
      });
    }
    this.files.set(path, content);
  }

  async mkdir(path: string, recursive: boolean): Promise<void> {
    this.record('mkdir', path, recursive);
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      if (!this.directories.has(current) && !recursive && current !== path) {
        throw new SandboxClientError(`parent missing ${current}`, 'file_not_found');
      }
      this.directories.add(current);
    }
  }

  async deleteFile(path: string): Promise<void> {
    this.record('deleteFile', path);
    if (!this.files.delete(path)) {
      throw new SandboxClientError(`ENOENT ${path}`, 'file_not_found', {
        sdkErrorName: 'FileNotFoundError',
      });
    }
  }

  async exists(path: string): Promise<boolean> {
    this.record('exists', path);
    return this.files.has(path) || this.directories.has(path);
  }

  async listFiles(path: string): Promise<readonly SandboxFileEntry[]> {
    this.record('listFiles', path);
    if (!this.directories.has(path)) {
      throw new SandboxClientError(`ENOENT ${path}`, 'file_not_found');
    }
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const entries: SandboxFileEntry[] = [];
    for (const [filePath, content] of this.files) {
      if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes('/')) {
        entries.push({
          name: filePath.slice(prefix.length),
          absolutePath: filePath,
          type: 'file',
          size: content.length,
          modifiedAt: '2026-01-01T00:00:00.000Z',
        });
      }
    }
    for (const dir of this.directories) {
      if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/') && dir !== path) {
        entries.push({
          name: dir.slice(prefix.length),
          absolutePath: dir,
          type: 'directory',
          size: 0,
          modifiedAt: '2026-01-01T00:00:00.000Z',
        });
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async info(): Promise<SandboxInfo> {
    this.record('info');
    return { sandboxId: this.sandboxId, placementId: null, sdkVersion: 'fake' };
  }

  async destroy(): Promise<void> {
    this.record('destroy');
    this.destroyed = true;
    this.files.clear();
    this.processes.clear();
  }

  private record(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
    if (this.failWith) throw this.failWith;
  }
}

/** Inverse of the adapter's `shellQuote`. */
export function shellUnquote(value: string): string {
  if (!value.startsWith(`'`) || !value.endsWith(`'`)) return value;
  return value.slice(1, -1).replace(/'\\''/g, `'`);
}

export interface UnwrappedShell {
  readonly command: string;
  readonly stdinPath?: string;
  readonly timeoutSeconds?: number;
}

/**
 * Peels `timeout -k G S sh -c '<inner>'` and `sh -c '<inner>' < '<file>'`
 * wrappers, in either nesting order, down to the user's command.
 */
export function unwrapAdapterShell(command: string): UnwrappedShell {
  let current = command;
  let stdinPath: string | undefined;
  let timeoutSeconds: number | undefined;
  for (let i = 0; i < 4; i += 1) {
    const timeoutMatch = /^timeout -k \S+ ([\d.]+) sh -c ('(?:[^']|'\\'')*')$/s.exec(current);
    if (timeoutMatch) {
      timeoutSeconds = Number(timeoutMatch[1]);
      current = shellUnquote(timeoutMatch[2] ?? '');
      continue;
    }
    const stdinMatch = /^sh -c ('(?:[^']|'\\'')*') < ('(?:[^']|'\\'')*')$/s.exec(current);
    if (stdinMatch) {
      stdinPath = shellUnquote(stdinMatch[2] ?? '');
      current = shellUnquote(stdinMatch[1] ?? '');
      continue;
    }
    break;
  }
  return {
    command: current,
    ...(stdinPath !== undefined ? { stdinPath } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
  };
}

export function defaultFakeScript(command: string, stdin: string | undefined): SandboxExecResult {
  const printf = /^printf\s+'([^']*)'$/.exec(command);
  if (printf) return { exitCode: 0, stdout: printf[1] ?? '', stderr: '' };
  const echo = /^echo\s+(.*)$/.exec(command);
  if (echo)
    return { exitCode: 0, stdout: `${(echo[1] ?? '').replace(/^'|'$/g, '')}\n`, stderr: '' };
  if (command === 'cat') return { exitCode: 0, stdout: stdin ?? '', stderr: '' };
  if (command === 'true') return { exitCode: 0, stdout: '', stderr: '' };
  if (command === 'false') return { exitCode: 1, stdout: '', stderr: '' };
  const exit = /^exit\s+(\d+)$/.exec(command);
  if (exit) return { exitCode: Number(exit[1]), stdout: '', stderr: '' };
  if (/^sleep\s+[\d.]+$/.test(command)) return { exitCode: 0, stdout: '', stderr: '' };
  return { exitCode: 127, stdout: '', stderr: `sh: 1: ${command}: not found\n` };
}
