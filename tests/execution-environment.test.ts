import { describe, expect, it } from 'vitest';
import {
  ExecutionEnvironmentError,
  type ExecutionEnvironment,
} from '../src/sandbox/execution-environment.js';
import { FakeExecutionEnvironment } from './support/fake-execution-environment.js';

/**
 * Contract suite for any ExecutionEnvironment. Phase 3 runs this same suite
 * against the Cloudflare Sandbox implementation; for now it is proven against
 * the fake so the contract itself is exercised.
 */
export function describeExecutionEnvironmentContract(
  name: string,
  create: () => Promise<ExecutionEnvironment>,
): void {
  describe(`ExecutionEnvironment contract: ${name}`, () => {
    it('reports a descriptor and a ready state', async () => {
      const env = await create();
      expect(env.descriptor.provider.length).toBeGreaterThan(0);
      const state = await env.getState();
      expect(state.descriptor).toEqual(env.descriptor);
      expect(state.status).toBe('ready');
      expect(state.workspaceRoot.startsWith('/')).toBe(true);
    });

    it('runs a command and returns a structured result', async () => {
      const env = await create();
      const result = await env.runCommand('echo hello');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
      expect(result.timedOut).toBe(false);
    });

    it('reports non-zero exit codes as results, not exceptions', async () => {
      const env = await create();
      const result = await env.runCommand('false');
      expect(result.exitCode).not.toBe(0);
    });

    it('round-trips files and lists directories', async () => {
      const env = await create();
      const state = await env.getState();
      const path = `${state.workspaceRoot}/notes/a.txt`;
      expect(await env.fileExists(path)).toBe(false);
      await env.writeFile(path, 'alpha');
      expect(await env.fileExists(path)).toBe(true);
      expect(await env.readFile(path)).toBe('alpha');
      const entries = await env.listDirectory(`${state.workspaceRoot}/notes`);
      expect(entries.map((e) => e.name)).toContain('a.txt');
      await env.deleteFile(path);
      expect(await env.fileExists(path)).toBe(false);
    });

    it('fails reads of missing files with a typed not_found error', async () => {
      const env = await create();
      await expect(env.readFile('/does/not/exist')).rejects.toBeInstanceOf(
        ExecutionEnvironmentError,
      );
      await expect(env.readFile('/does/not/exist')).rejects.toMatchObject({ code: 'not_found' });
    });

    it('starts, tracks and stops background processes', async () => {
      const env = await create();
      const handle = await env.startProcess('sleep 1000');
      let state = await env.getState();
      expect(state.processes.find((p) => p.processId === handle.processId)?.status).toBe('running');
      await env.stopProcess(handle.processId);
      state = await env.getState();
      expect(state.processes.find((p) => p.processId === handle.processId)?.status).toBe('killed');
    });
  });
}

describeExecutionEnvironmentContract('fake', async () => new FakeExecutionEnvironment());
