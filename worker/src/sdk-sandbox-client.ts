import { getSandbox, type Process, type Sandbox } from '@cloudflare/sandbox';
import {
  SandboxClientError,
  classifySdkError,
  type SandboxClient,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxFileEntry,
  type SandboxInfo,
  type SandboxProcessRecord,
  type SandboxStartProcessOptions,
} from '../../src/sandbox/cloudflare/sandbox-client.js';

export interface SdkSandboxClientOptions {
  /** Idle time before the container stops (SDK `sleepAfter`, default "10m"). */
  readonly sleepAfter?: string;
  readonly sdkVersion: string;
}

/**
 * The only code in the repository that calls the Cloudflare Sandbox SDK. It
 * runs inside the gateway Worker and is a thin pass-through: no policy, no
 * contract mapping, only shape normalisation and error classification.
 *
 * Choices made here (all recorded in ADR-001):
 * - `enableDefaultSession: false` — each `exec` is independent; the
 *   provider-neutral contract passes `cwd`/`env` per call and has no hidden
 *   shell state. (Also the SDK's recommended forward-compatible setting.)
 * - `normalizeId: true` — lowercase ids, the SDK's future default.
 */
export class SdkSandboxClient implements SandboxClient {
  private readonly sandbox: Sandbox;
  private readonly sdkVersion: string;

  constructor(
    namespace: DurableObjectNamespace<Sandbox>,
    readonly sandboxId: string,
    options: SdkSandboxClientOptions,
  ) {
    this.sdkVersion = options.sdkVersion;
    this.sandbox = getSandbox(namespace, sandboxId, {
      enableDefaultSession: false,
      normalizeId: true,
      ...(options.sleepAfter ? { sleepAfter: options.sleepAfter } : {}),
    });
  }

  async exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult> {
    const result = await wrap(() =>
      this.sandbox.exec(command, {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.env !== undefined ? { env: { ...options.env } } : {}),
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      }),
    );
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async startProcess(
    command: string,
    options?: SandboxStartProcessOptions,
  ): Promise<SandboxProcessRecord> {
    const process = await wrap(() =>
      this.sandbox.startProcess(command, {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.env !== undefined ? { env: { ...options.env } } : {}),
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options?.autoCleanup !== undefined ? { autoCleanup: options.autoCleanup } : {}),
      }),
    );
    return toRecord(process);
  }

  async listProcesses(): Promise<readonly SandboxProcessRecord[]> {
    const processes = await wrap(() => this.sandbox.listProcesses());
    return processes.map(toRecord);
  }

  async killProcess(processId: string, signal?: string): Promise<void> {
    await wrap(() => this.sandbox.killProcess(processId, signal));
  }

  async readFile(path: string): Promise<string> {
    const result = await wrap(() => this.sandbox.readFile(path, { encoding: 'utf-8' }));
    return result.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await wrap(() => this.sandbox.writeFile(path, content));
  }

  async mkdir(path: string, recursive: boolean): Promise<void> {
    await wrap(() => this.sandbox.mkdir(path, { recursive }));
  }

  async deleteFile(path: string): Promise<void> {
    await wrap(() => this.sandbox.deleteFile(path));
  }

  async exists(path: string): Promise<boolean> {
    const result = await wrap(() => this.sandbox.exists(path));
    return result.exists;
  }

  async listFiles(path: string): Promise<readonly SandboxFileEntry[]> {
    const result = await wrap(() => this.sandbox.listFiles(path));
    return result.files.map((file) => ({
      name: file.name,
      absolutePath: file.absolutePath,
      type: file.type,
      size: file.size,
      modifiedAt: file.modifiedAt,
    }));
  }

  async info(): Promise<SandboxInfo> {
    const placementId = await wrap(() => this.sandbox.getContainerPlacementId());
    return {
      sandboxId: this.sandboxId,
      ...(placementId !== undefined ? { placementId } : {}),
      sdkVersion: this.sdkVersion,
    };
  }

  async destroy(): Promise<void> {
    await wrap(() => this.sandbox.destroy());
  }
}

function toRecord(process: Process): SandboxProcessRecord {
  return {
    id: process.id,
    ...(process.pid !== undefined ? { pid: process.pid } : {}),
    command: process.command,
    status: process.status,
    startedAt: toIso(process.startTime),
    ...(process.endTime ? { endedAt: toIso(process.endTime) } : {}),
    ...(process.exitCode !== undefined ? { exitCode: process.exitCode } : {}),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function wrap<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SandboxClientError) throw error;
    const name = error instanceof Error ? error.name : undefined;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new SandboxClientError(message, classifySdkError(name, code), {
      ...(name ? { sdkErrorName: name } : {}),
      ...(code ? { sdkErrorCode: code } : {}),
    });
  }
}
