import { describe, expect, it } from 'vitest';
import {
  CloudflareSandboxEnvironment,
  parentDirectory,
  shellQuote,
  toEnvironmentError,
} from '../../src/sandbox/cloudflare/cloudflare-sandbox-environment.js';
import {
  SandboxClientError,
  classifySdkError,
} from '../../src/sandbox/cloudflare/sandbox-client.js';
import { ExecutionEnvironmentError } from '../../src/sandbox/execution-environment.js';
import { describeExecutionEnvironmentContract } from '../support/execution-environment-contract.js';
import { FakeSandboxClient, unwrapAdapterShell } from '../support/fake-sandbox-client.js';

/**
 * TESTED ONLY WITH A FAKE CLIENT. These tests prove the adapter's mapping from
 * the provider-neutral contract onto the Cloudflare-shaped client port. They
 * say nothing about Cloudflare itself; see tests/integration/cloudflare/.
 */

function build(client = new FakeSandboxClient('unit-sandbox')) {
  return { client, env: new CloudflareSandboxEnvironment(client) };
}

describeExecutionEnvironmentContract(
  'cloudflare adapter over FakeSandboxClient',
  async () => build().env,
);

describe('CloudflareSandboxEnvironment · descriptor and state', () => {
  it('identifies itself as cloudflare-sandbox with the sandbox id', async () => {
    const { env } = build();
    expect(env.descriptor).toEqual({
      provider: 'cloudflare-sandbox',
      environmentId: 'unit-sandbox',
    });
    const state = await env.getState();
    expect(state.workspaceRoot).toBe('/workspace');
    expect(state.metadata['sandboxId']).toBe('unit-sandbox');
    expect(state.metadata['sdkVersion']).toBe('fake');
  });

  it('reports "starting" (not an exception) when the container is unavailable', async () => {
    const { client, env } = build();
    client.failWith = new SandboxClientError('container not ready', 'container_unavailable');
    const state = await env.getState();
    expect(state.status).toBe('starting');
    expect(state.metadata['lastErrorKind']).toBe('container_unavailable');
  });

  it('reports "error" for other failures and throws only for misconfiguration', async () => {
    const { client, env } = build();
    client.failWith = new SandboxClientError('boom', 'unknown');
    expect((await env.getState()).status).toBe('error');
    client.failWith = new SandboxClientError('bad token', 'unauthorized');
    await expect(env.getState()).rejects.toMatchObject({ code: 'internal' });
  });

  it('reports "stopped" after destroy()', async () => {
    const { client, env } = build();
    await env.destroy();
    expect(client.destroyed).toBe(true);
    expect((await env.getState()).status).toBe('stopped');
  });
});

describe('CloudflareSandboxEnvironment · runCommand', () => {
  it('passes the command straight through when no options need wrapping', async () => {
    const { client, env } = build();
    const result = await env.runCommand(`printf 'agent-sandbox-ok'`, {
      cwd: '/workspace',
      env: { A: '1' },
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'agent-sandbox-ok', timedOut: false });
    expect(result.command).toBe(`printf 'agent-sandbox-ok'`);
    const call = client.calls.find((c) => c.op === 'exec');
    expect(call?.args[0]).toBe(`printf 'agent-sandbox-ok'`);
    expect(call?.args[1]).toEqual({ cwd: '/workspace', env: { A: '1' } });
  });

  it('returns non-zero exit codes as results', async () => {
    const { env } = build();
    expect((await env.runCommand('exit 3')).exitCode).toBe(3);
    const notFound = await env.runCommand('definitely-not-a-command');
    expect(notFound.exitCode).toBe(127);
    expect(notFound.stderr).toContain('not found');
  });

  it('emulates stdin by staging a temp file, redirecting it, and deleting it afterwards', async () => {
    const { client, env } = build();
    const result = await env.runCommand('cat', { stdin: "it's <piped>\nline 2" });
    expect(result.stdout).toBe("it's <piped>\nline 2");

    const ops = client.calls.map((c) => c.op);
    expect(ops).toEqual(['writeFile', 'exec', 'deleteFile']);
    const staged = client.calls[0]?.args[0] as string;
    expect(staged.startsWith('/tmp/.agent-stdin-')).toBe(true);
    expect(client.calls[2]?.args[0]).toBe(staged);
    expect(client.files.has(staged)).toBe(false);

    const shell = client.calls[1]?.args[0] as string;
    expect(unwrapAdapterShell(shell)).toEqual({ command: 'cat', stdinPath: staged });
  });

  it('still deletes the staged stdin file when the command itself fails', async () => {
    const { client, env } = build();
    client.setCommandScript(() => {
      throw new SandboxClientError('container gone', 'container_unavailable');
    });
    await expect(env.runCommand('cat', { stdin: 'x' })).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(client.calls.map((c) => c.op)).toEqual(['writeFile', 'exec', 'deleteFile']);
  });

  it('enforces timeouts inside the sandbox with timeout(1) and reports timedOut with a null exit code', async () => {
    const { client, env } = build();
    const result = await env.runCommand('sleep 5', { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(50);

    const shell = client.calls.find((c) => c.op === 'exec')?.args[0] as string;
    expect(unwrapAdapterShell(shell)).toEqual({ command: 'sleep 5', timeoutSeconds: 0.1 });
    // The SDK-side deadline is only a backstop, granted extra time beyond the command's own.
    const options = client.calls.find((c) => c.op === 'exec')?.args[1] as { timeoutMs: number };
    expect(options.timeoutMs).toBe(50 + 10_000);
  });

  it('does not misreport a fast exit status 124 as a timeout', async () => {
    const { env } = build();
    const result = await env.runCommand('exit 124', { timeoutMs: 5_000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(124);
  });

  it('combines stdin and timeout wrappers', async () => {
    const { client, env } = build();
    const result = await env.runCommand('cat', { stdin: 'payload', timeoutMs: 1_000 });
    expect(result.stdout).toBe('payload');
    const shell = client.calls.find((c) => c.op === 'exec')?.args[0] as string;
    const unwrapped = unwrapAdapterShell(shell);
    expect(unwrapped.command).toBe('cat');
    expect(unwrapped.timeoutSeconds).toBe(1);
    expect(unwrapped.stdinPath).toBeDefined();
  });

  it('turns an SDK request deadline into a timedOut result when a command deadline was requested', async () => {
    const { client, env } = build();
    client.setCommandScript(() => {
      throw new SandboxClientError('request timed out', 'request_timeout');
    });
    const result = await env.runCommand('sleep 999', { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('output unavailable');
  });

  it('surfaces environment-level failures as typed ExecutionEnvironmentError', async () => {
    const { client, env } = build();
    client.setCommandScript(() => {
      throw new SandboxClientError('request timed out', 'request_timeout');
    });
    await expect(env.runCommand('sleep 999')).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('CloudflareSandboxEnvironment · files', () => {
  it('creates parent directories before writing', async () => {
    const { client, env } = build();
    await env.writeFile('/workspace/deep/er/file.txt', 'x');
    expect(client.calls.map((c) => c.op)).toEqual(['mkdir', 'writeFile']);
    expect(client.calls[0]?.args).toEqual(['/workspace/deep/er', true]);
    expect(await env.readFile('/workspace/deep/er/file.txt')).toBe('x');
  });

  it('maps directory listings to DirectoryEntry', async () => {
    const { env } = build();
    await env.writeFile('/workspace/list/a.txt', 'aaa');
    await env.writeFile('/workspace/list/sub/b.txt', 'b');
    const entries = await env.listDirectory('/workspace/list');
    expect(entries).toEqual([
      { name: 'a.txt', path: '/workspace/list/a.txt', type: 'file', sizeBytes: 3 },
      { name: 'sub', path: '/workspace/list/sub', type: 'directory', sizeBytes: 0 },
    ]);
  });

  it('maps file_not_found to not_found for read, delete and list', async () => {
    const { env } = build();
    await expect(env.readFile('/nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(env.deleteFile('/nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(env.listDirectory('/nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('CloudflareSandboxEnvironment · processes', () => {
  it('starts processes with autoCleanup disabled so they remain inspectable', async () => {
    const { client, env } = build();
    const handle = await env.startProcess('sleep 1000', { cwd: '/workspace' });
    expect(handle.processId).toBe('proc-1');
    expect(handle.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(client.calls[0]?.args[1]).toEqual({ cwd: '/workspace', autoCleanup: false });
  });

  it('keeps a stopped process reported as killed even if the sandbox files it as failed', async () => {
    const { client, env } = build();
    const handle = await env.startProcess('sleep 1000');
    await env.stopProcess(handle.processId);
    const record = client.processes.get(handle.processId)!;
    client.processes.set(handle.processId, { ...record, status: 'failed', exitCode: 143 });
    const state = await env.getState();
    expect(state.processes).toEqual([
      { processId: 'proc-1', command: 'sleep 1000', status: 'killed', exitCode: 143 },
    ]);
  });

  it('reports a process the sandbox no longer tracks as exited', async () => {
    const { client, env } = build();
    const handle = await env.startProcess('sleep 1');
    client.forgetProcess(handle.processId);
    const state = await env.getState();
    expect(state.processes[0]?.status).toBe('exited');
  });

  it('includes processes started outside this instance', async () => {
    const { client, env } = build();
    await client.startProcess('node server.js');
    const state = await env.getState();
    expect(state.processes.map((p) => p.command)).toEqual(['node server.js']);
  });

  it('maps process_not_found on stop to not_found', async () => {
    const { env } = build();
    await expect(env.stopProcess('ghost')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('error and helper mapping', () => {
  it('maps client error kinds onto ExecutionEnvironmentError codes', () => {
    const map = (kind: ConstructorParameters<typeof SandboxClientError>[1]) =>
      toEnvironmentError(new SandboxClientError('m', kind), 'ctx').code;
    expect(map('file_not_found')).toBe('not_found');
    expect(map('process_not_found')).toBe('not_found');
    expect(map('permission_denied')).toBe('permission_denied');
    expect(map('container_unavailable')).toBe('unavailable');
    expect(map('request_timeout')).toBe('unavailable');
    expect(map('unauthorized')).toBe('internal');
    expect(map('protocol')).toBe('internal');
    expect(toEnvironmentError(new Error('plain'), 'ctx')).toBeInstanceOf(ExecutionEnvironmentError);
    const passthrough = new ExecutionEnvironmentError('x', 'not_found');
    expect(toEnvironmentError(passthrough, 'ctx')).toBe(passthrough);
  });

  it('classifies SDK error names and codes', () => {
    expect(classifySdkError('FileNotFoundError')).toBe('file_not_found');
    expect(classifySdkError('ProcessNotFoundError')).toBe('process_not_found');
    expect(classifySdkError('PermissionDeniedError')).toBe('permission_denied');
    expect(classifySdkError('ContainerUnavailableError')).toBe('container_unavailable');
    expect(classifySdkError('SandboxError', 'FILE_NOT_FOUND')).toBe('file_not_found');
    expect(classifySdkError('Error')).toBe('unknown');
    expect(classifySdkError(undefined)).toBe('unknown');
  });

  it('quotes shell strings safely', () => {
    expect(shellQuote('plain')).toBe(`'plain'`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    expect(shellQuote('a\nb $HOME `x`')).toBe(`'a\nb $HOME \`x\`'`);
  });

  it('computes parent directories', () => {
    expect(parentDirectory('/workspace/a/b.txt')).toBe('/workspace/a');
    expect(parentDirectory('/workspace/a/')).toBe('/workspace');
    expect(parentDirectory('/top.txt')).toBeUndefined();
    expect(parentDirectory('relative')).toBeUndefined();
  });
});
