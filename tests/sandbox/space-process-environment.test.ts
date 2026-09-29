import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  mapSpaceWorkspaceCommand,
  mapSpaceWorkspacePath,
  SpaceProcessEnvironment,
} from '../../src/sandbox/space/space-process-environment.js';
import { describeExecutionEnvironmentContract } from '../support/execution-environment-contract.js';

const linux = platform() === 'linux';

describe('Space workspace alias', () => {
  const root = '/tmp/agent-space-abc';

  it('maps /workspace onto the ephemeral root and leaves the real root alone', () => {
    expect(mapSpaceWorkspacePath(root, '/workspace')).toBe(root);
    expect(mapSpaceWorkspacePath(root, '/workspace/lesson.txt')).toBe(`${root}/lesson.txt`);
    expect(mapSpaceWorkspacePath(root, '/workspace/.agent/http/body')).toBe(
      `${root}/.agent/http/body`,
    );
    expect(mapSpaceWorkspacePath(root, `${root}/lesson.txt`)).toBe(`${root}/lesson.txt`);
    expect(mapSpaceWorkspacePath('/workspace', '/workspace/lesson.txt')).toBe(
      '/workspace/lesson.txt',
    );
  });

  it('rejects escapes and paths that are not the workspace', () => {
    expect(mapSpaceWorkspacePath(root, '/workspace/../etc/passwd')).toBeUndefined();
    expect(mapSpaceWorkspacePath(root, '/etc/passwd')).toBeUndefined();
    expect(mapSpaceWorkspacePath(root, 'lesson.txt')).toBeUndefined();
  });

  it('rewrites /workspace tokens in a tool command and leaves URLs alone', () => {
    expect(
      mapSpaceWorkspaceCommand(
        root,
        "mkdir -p /workspace/.agent/http && printf x > '/workspace/.agent/http/body'",
      ),
    ).toBe(`mkdir -p ${root}/.agent/http && printf x > '${root}/.agent/http/body'`);
    expect(mapSpaceWorkspaceCommand(root, 'curl -o /tmp/x https://example.com/workspace/x')).toBe(
      'curl -o /tmp/x https://example.com/workspace/x',
    );
    expect(mapSpaceWorkspaceCommand('/workspace', 'mkdir -p /workspace/.agent')).toBe(
      'mkdir -p /workspace/.agent',
    );
  });
});

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

  it('writes the default /workspace goal path inside the ephemeral root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-space-alias-'));
    const environment = await SpaceProcessEnvironment.start({
      workspaceRoot: root,
      environmentId: 'space-alias',
      ephemeral: true,
    });
    const marker = 'Example Domain alias marker';
    try {
      await environment.writeFile('/workspace/lesson.txt', `${marker}\n`);
      expect(await environment.readFile('/workspace/lesson.txt')).toContain(marker);
      expect(await environment.readFile(`${root}/lesson.txt`)).toContain(marker);
      expect(await environment.fileExists('/workspace/lesson.txt')).toBe(true);

      const scratch = await environment.runCommand(
        'mkdir -p /workspace/.agent/http && printf fetched > /workspace/.agent/http/body.txt',
        { cwd: '/workspace' },
      );
      expect(scratch.exitCode).toBe(0);
      expect(await environment.readFile('/workspace/.agent/http/body.txt')).toBe('fetched');
      expect(await environment.readFile(`${root}/.agent/http/body.txt`)).toBe('fetched');

      await expect(environment.writeFile('/etc/passwd', 'no')).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(environment.writeFile('/workspace/../etc/passwd', 'no')).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(await environment.fileExists('/etc/passwd')).toBe(false);
    } finally {
      await environment.destroy();
    }
    const { existsSync } = await import('node:fs');
    expect(existsSync('/workspace/lesson.txt')).toBe(false);
    expect(existsSync('/workspace/.agent/http/body.txt')).toBe(false);
    expect(existsSync(root)).toBe(false);
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
