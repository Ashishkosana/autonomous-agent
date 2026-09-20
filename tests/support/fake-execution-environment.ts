import type {
  CommandOptions,
  CommandResult,
  DirectoryEntry,
  EnvironmentDescriptor,
  EnvironmentState,
  ExecutionEnvironment,
  ProcessHandle,
  ProcessState,
} from '../../src/sandbox/execution-environment.js';
import { ExecutionEnvironmentError } from '../../src/sandbox/execution-environment.js';

export type CommandScript = (command: string, options?: CommandOptions) => CommandResult;

/**
 * In-memory ExecutionEnvironment for contract tests. Files live in a Map;
 * commands are answered by a scripted function so tests can force exit codes.
 */
export class FakeExecutionEnvironment implements ExecutionEnvironment {
  readonly descriptor: EnvironmentDescriptor = { provider: 'fake', environmentId: 'fake-1' };
  readonly files = new Map<string, string>();
  readonly commandLog: string[] = [];
  private readonly processes = new Map<string, ProcessState>();
  private processCounter = 0;

  constructor(
    readonly workspaceRoot = '/workspace',
    private script: CommandScript = defaultScript,
  ) {}

  setCommandScript(script: CommandScript): void {
    this.script = script;
  }

  async runCommand(command: string, options?: CommandOptions): Promise<CommandResult> {
    this.commandLog.push(command);
    return this.script(command, options);
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new ExecutionEnvironmentError(`No such file: ${path}`, 'not_found');
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    if (!this.files.delete(path)) {
      throw new ExecutionEnvironmentError(`No such file: ${path}`, 'not_found');
    }
  }

  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const entries: DirectoryEntry[] = [];
    const seenDirs = new Set<string>();
    for (const [filePath, content] of this.files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ name: rest, path: filePath, type: 'file', sizeBytes: content.length });
      } else {
        const dir = rest.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          entries.push({ name: dir, path: `${prefix}${dir}`, type: 'directory' });
        }
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async startProcess(command: string): Promise<ProcessHandle> {
    this.processCounter += 1;
    const processId = `proc-${this.processCounter}`;
    this.processes.set(processId, { processId, command, status: 'running' });
    return { processId, command, startedAt: new Date(0).toISOString() };
  }

  async stopProcess(processId: string): Promise<void> {
    const state = this.processes.get(processId);
    if (!state) throw new ExecutionEnvironmentError(`No such process: ${processId}`, 'not_found');
    this.processes.set(processId, { ...state, status: 'killed' });
  }

  async getState(): Promise<EnvironmentState> {
    return {
      descriptor: this.descriptor,
      status: 'ready',
      workspaceRoot: this.workspaceRoot,
      processes: [...this.processes.values()],
      metadata: { fileCount: this.files.size },
    };
  }
}

function defaultScript(command: string): CommandResult {
  const echo = /^echo\s+(.*)$/.exec(command);
  if (echo) {
    return {
      command,
      exitCode: 0,
      stdout: `${echo[1] ?? ''}\n`,
      stderr: '',
      durationMs: 1,
      timedOut: false,
    };
  }
  if (command === 'false') {
    return { command, exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false };
  }
  return {
    command,
    exitCode: 127,
    stdout: '',
    stderr: `fake: command not found: ${command}\n`,
    durationMs: 1,
    timedOut: false,
  };
}
