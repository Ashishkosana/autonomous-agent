import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SpaceProcessEnvironment } from '../../src/sandbox/space/space-process-environment.js';
import { describeExecutionEnvironmentContract } from '../support/execution-environment-contract.js';

const linux = platform() === 'linux';

describe.skipIf(!linux)('SpaceProcessEnvironment', () => {
  describeExecutionEnvironmentContract('space-process', async () =>
    SpaceProcessEnvironment.start({
      workspaceRoot: mkdtempSync(join(tmpdir(), 'agent-space-contract-')),
      environmentId: `space-contract-${Date.now()}`,
      ephemeral: true,
    }),
  );

  it('does not pass the process environment into commands', async () => {
    const previous = process.env['AGENT_SPACE_LEAK_PROBE'];
    process.env['AGENT_SPACE_LEAK_PROBE'] = 'should-not-leak';
    const root = mkdtempSync(join(tmpdir(), 'agent-space-leak-'));
    const environment = await SpaceProcessEnvironment.start({
      workspaceRoot: root,
      environmentId: 'space-leak',
      ephemeral: true,
    });
    try {
      const result = await environment.runCommand('printf %s "$AGENT_SPACE_LEAK_PROBE"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      const state = await environment.getState();
      expect(state.metadata['nestedDocker']).toBe(false);
      expect(state.descriptor.provider).toBe('space-process');
    } finally {
      await environment.destroy();
      if (previous === undefined) delete process.env['AGENT_SPACE_LEAK_PROBE'];
      else process.env['AGENT_SPACE_LEAK_PROBE'] = previous;
    }
  });

  it('removes an ephemeral workspace under /tmp and refuses to delete /tmp itself', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-space-ephemeral-'));
    const environment = await SpaceProcessEnvironment.start({
      workspaceRoot: root,
      environmentId: 'space-ephemeral',
      ephemeral: true,
    });
    await environment.writeFile(`${root}/note.txt`, 'kept until destroy');
    await environment.destroy();
    const { existsSync } = await import('node:fs');
    expect(existsSync(root)).toBe(false);

    const refused = await SpaceProcessEnvironment.start({
      workspaceRoot: '/tmp',
      environmentId: 'space-refuse',
      ephemeral: true,
    });
    await expect(refused.destroy()).rejects.toMatchObject({ code: 'internal' });
  });

  it('cleans a non-ephemeral directory the test created', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-space-keep-'));
    const environment = await SpaceProcessEnvironment.start({
      workspaceRoot: root,
      environmentId: 'space-keep',
    });
    await environment.destroy();
    rmSync(root, { recursive: true, force: true });
  });
});
