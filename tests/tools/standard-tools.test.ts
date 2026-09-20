import { describe, expect, it } from 'vitest';
import { ExecutionEnvironmentError } from '../../src/sandbox/execution-environment.js';
import { invokeTool, ToolRegistry } from '../../src/tools/registry.js';
import {
  createStandardToolRegistry,
  createStandardTools,
  STANDARD_TOOL_FAMILIES,
} from '../../src/tools/standard-tools.js';
import { resolveToolOptions } from '../../src/tools/support/options.js';
import { makeHarness, type TestHarness } from '../support/fixtures.js';

const options = resolveToolOptions({
  maxOutputChars: 50,
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 20_000,
});

function setup(): { harness: TestHarness; registry: ToolRegistry } {
  const harness = makeHarness();
  const registry = createStandardToolRegistry({ options });
  return { harness, registry };
}

async function ok<T>(
  harness: TestHarness,
  registry: ToolRegistry,
  tool: string,
  input: unknown,
): Promise<T> {
  const result = await invokeTool(registry, tool, input, harness.toolContext());
  expect(result.status, JSON.stringify(result)).toBe('ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  return result.output as T;
}

async function error(harness: TestHarness, registry: ToolRegistry, tool: string, input: unknown) {
  const result = await invokeTool(registry, tool, input, harness.toolContext());
  expect(result.status).toBe('error');
  if (result.status !== 'error') throw new Error('unreachable');
  return result.error;
}

describe('standard tool catalogue', () => {
  it('registers the six V1 families; web.search only with a provider', () => {
    const names = createStandardToolRegistry().names();
    expect(names).toEqual([
      'fs.read',
      'fs.write',
      'fs.list',
      'fs.delete',
      'shell.run',
      'code.run',
      'http.request',
      'web.fetch',
      'git',
    ]);
    const withSearch = createStandardTools({
      searchProvider: { name: 'fake', search: async () => [] },
    }).map((t) => t.name);
    expect(withSearch).toContain('web.search');
    expect(new Set(createStandardTools().map((t) => t.family))).toEqual(
      new Set(STANDARD_TOOL_FAMILIES),
    );
  });

  it('families are the permission model: an unregistered family is unknown to the run', async () => {
    const { harness } = setup();
    const registry = createStandardToolRegistry({ families: ['filesystem'] });
    expect(registry.names()).toEqual(['fs.read', 'fs.write', 'fs.list', 'fs.delete']);
    const failure = await error(harness, registry, 'shell.run', { command: 'id' });
    expect(failure.code).toBe('unknown_tool');
    expect(harness.environment.commandLog).toEqual([]);
  });

  it('every descriptor is a JSON object schema with a description and no execute()', () => {
    for (const descriptor of createStandardToolRegistry().describeAll()) {
      expect(descriptor.inputSchema.type).toBe('object');
      expect(descriptor.description.length).toBeGreaterThan(10);
      expect(descriptor).not.toHaveProperty('execute');
    }
  });
});

describe('filesystem tools over the fake environment', () => {
  it('fs.write creates then changes, emits FILE_CREATED/FILE_CHANGED and yields an artifact', async () => {
    const { harness, registry } = setup();
    const first = await invokeTool(
      registry,
      'fs.write',
      { path: 'out/a.txt', content: 'héllo' },
      harness.toolContext(),
    );
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.output).toEqual({ path: '/workspace/out/a.txt', bytes: 6, created: true });
    expect(first.artifacts).toHaveLength(1);
    expect(first.artifacts?.[0]).toMatchObject({
      kind: 'file',
      location: { storage: 'sandbox', path: '/workspace/out/a.txt' },
      sizeBytes: 6,
      producedBy: { actionIds: ['act-1'] },
    });

    const second = await ok<{ created: boolean }>(harness, registry, 'fs.write', {
      path: '/workspace/out/a.txt',
      content: '',
    });
    expect(second.created).toBe(false);
    expect(harness.events.events.map((e) => e.type)).toEqual(['FILE_CREATED', 'FILE_CHANGED']);
    expect(harness.events.events[0]?.correlation.actionId).toBe('act-1');
    expect(harness.environment.files.get('/workspace/out/a.txt')).toBe('');
  });

  it('paths that leave the workspace are rejected before anything is touched', async () => {
    const { harness, registry } = setup();
    for (const tool of ['fs.read', 'fs.write', 'fs.delete']) {
      const failure = await error(harness, registry, tool, {
        path: '../../etc/passwd',
        content: 'x',
      });
      expect(failure.code).toBe('invalid_input');
      expect(String(failure.details)).toMatch(/inside the workspace/);
    }
    const list = await error(harness, registry, 'fs.list', { path: '/etc' });
    expect(list.code).toBe('invalid_input');
    expect(harness.environment.files.size).toBe(0);
  });

  it('fs.read caps content and reports the true size; a missing file is a non-retryable not_found', async () => {
    const { harness, registry } = setup();
    harness.environment.files.set('/workspace/big.txt', 'y'.repeat(200));
    const read = await ok<{ content: string; truncated: boolean; sizeChars: number }>(
      harness,
      registry,
      'fs.read',
      {
        path: 'big.txt',
        maxChars: 10,
      },
    );
    expect(read.truncated).toBe(true);
    expect(read.sizeChars).toBe(200);
    expect(read.content.startsWith('yyyyyyyyyy…')).toBe(true);

    const missing = await error(harness, registry, 'fs.read', { path: 'nope.txt' });
    expect(missing.code).toBe('not_found');
    expect(missing.retryable).toBe(false);
    expect(missing.details).toBeInstanceOf(ExecutionEnvironmentError);
  });

  it('fs.list defaults to the workspace root; fs.delete refuses the root and emits FILE_DELETED', async () => {
    const { harness, registry } = setup();
    harness.environment.files.set('/workspace/a.txt', 'a');
    harness.environment.files.set('/workspace/dir/b.txt', 'bb');
    const listing = await ok<{ path: string; entries: { name: string; type: string }[] }>(
      harness,
      registry,
      'fs.list',
      {},
    );
    expect(listing.path).toBe('/workspace');
    expect(listing.entries.map((e) => `${e.type}:${e.name}`)).toEqual([
      'file:a.txt',
      'directory:dir',
    ]);

    expect((await error(harness, registry, 'fs.delete', { path: '/workspace' })).code).toBe(
      'invalid_input',
    );
    await ok(harness, registry, 'fs.delete', { path: 'a.txt' });
    expect(harness.environment.files.has('/workspace/a.txt')).toBe(false);
    expect(harness.events.ofType('FILE_DELETED')[0]?.payload.path).toBe('/workspace/a.txt');
  });
});

describe('shell.run over the fake environment', () => {
  it('passes the command string through untouched, applies cwd and the clamped timeout, and narrates it with COMMAND_* events', async () => {
    const { harness, registry } = setup();
    const seen: unknown[] = [];
    harness.environment.setCommandScript((command, opts) => {
      seen.push({ command, opts });
      return {
        command,
        exitCode: 3,
        stdout: 'out'.repeat(40),
        stderr: 'warn',
        durationMs: 7,
        timedOut: false,
      };
    });
    const output = await ok<Record<string, unknown>>(harness, registry, 'shell.run', {
      command: `echo "it's $HOME" | wc -c`,
      cwd: 'sub',
      timeoutMs: 999_999,
      stdin: 'in',
    });
    expect(seen).toEqual([
      {
        command: `echo "it's $HOME" | wc -c`,
        opts: { cwd: '/workspace/sub', timeoutMs: 20_000, stdin: 'in' },
      },
    ]);
    expect(output).toMatchObject({
      exitCode: 3,
      timedOut: false,
      stderr: 'warn',
      stdoutTruncated: true,
    });
    expect(harness.events.events.map((e) => e.type)).toEqual([
      'COMMAND_STARTED',
      'COMMAND_OUTPUT',
      'COMMAND_OUTPUT',
      'COMMAND_FINISHED',
    ]);
    expect(harness.events.ofType('COMMAND_FINISHED')[0]?.payload).toEqual({
      command: `echo "it's $HOME" | wc -c`,
      exitCode: 3,
      durationMs: 7,
      timedOut: false,
    });
  });

  it('a non-zero exit code is an ok tool result — judging it is the evaluator’s job', async () => {
    const { harness, registry } = setup();
    const output = await ok<{ exitCode: number }>(harness, registry, 'shell.run', {
      command: 'false',
    });
    expect(output.exitCode).toBe(1);
  });

  it('rejects a cwd outside the workspace and an empty command', async () => {
    const { harness, registry } = setup();
    expect((await error(harness, registry, 'shell.run', { command: 'id', cwd: '/tmp' })).code).toBe(
      'invalid_input',
    );
    expect((await error(harness, registry, 'shell.run', { command: '' })).code).toBe(
      'invalid_input',
    );
    expect(harness.environment.commandLog).toEqual([]);
  });
});

describe('code.run over the fake environment', () => {
  it('stages the source under the scratch dir, runs the interpreter with quoted args, and records a code artifact', async () => {
    const { harness, registry } = setup();
    const result = await invokeTool(
      registry,
      'code.run',
      { language: 'python', source: 'print(1)\n', args: ['a b', "c'd"] },
      harness.toolContext(),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const sourcePath = '/workspace/.agent/code/act-1.py';
    expect(harness.environment.files.get(sourcePath)).toBe('print(1)\n');
    expect(harness.environment.commandLog).toEqual([`python3 ${sourcePath} 'a b' 'c'\\''d'`]);
    expect(result.output).toMatchObject({ language: 'python', sourcePath, exitCode: 127 });
    expect(result.artifacts?.[0]).toMatchObject({
      kind: 'code',
      location: { storage: 'sandbox', path: sourcePath },
    });
    expect(harness.events.events.map((e) => e.type)).toEqual([
      'FILE_CREATED',
      'COMMAND_STARTED',
      'COMMAND_OUTPUT',
      'COMMAND_FINISHED',
    ]);
  });

  it('rejects unknown languages and missing source', async () => {
    const { harness, registry } = setup();
    const failure = await error(harness, registry, 'code.run', {
      language: 'ruby',
      source: 'puts 1',
    });
    expect(failure.code).toBe('invalid_input');
    expect(String(failure.details)).toMatch(/language must be one of python, node, sh/);
    expect((await error(harness, registry, 'code.run', { language: 'sh' })).code).toBe(
      'invalid_input',
    );
  });
});

describe('git over the fake environment', () => {
  it('prepends a fixed identity, disables prompts, and only allows listed subcommands', async () => {
    const { harness, registry } = setup();
    const seen: unknown[] = [];
    harness.environment.setCommandScript((command, opts) => {
      seen.push({ command, env: opts?.env, cwd: opts?.cwd });
      return { command, exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    });
    await ok(harness, registry, 'git', { args: ['commit', '-m', 'first commit'], cwd: 'repo' });
    expect(seen).toEqual([
      {
        command:
          "git -c user.name=agent -c user.email=agent@sandbox.invalid commit -m 'first commit'",
        env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' },
        cwd: '/workspace/repo',
      },
    ]);
  });

  it('refuses push, config injection, credentialed or non-http remotes', async () => {
    const { harness, registry } = setup();
    const cases: [unknown, RegExp][] = [
      [{ args: ['push', 'origin', 'main'] }, /subcommand not allowed: push/],
      [{ args: ['config', 'credential.helper', 'store'] }, /subcommand not allowed: config/],
      [{ args: ['status', '-c', 'core.sshCommand=evil'] }, /argument not allowed: -c/],
      [{ args: ['log', '--exec-path=/tmp'] }, /argument not allowed/],
      [{ args: ['clone', 'git@github.com:x/y.git'] }, /must be http\(s\)/],
      [{ args: ['clone', 'ssh://host/x.git'] }, /must be http\(s\)/],
      [{ args: ['clone', 'https://user:token@github.com/x/y.git'] }, /must not embed credentials/],
      [{ args: [] }, /must start with a git subcommand/],
    ];
    for (const [input, pattern] of cases) {
      const failure = await error(harness, registry, 'git', input);
      expect(failure.code, JSON.stringify(input)).toBe('invalid_input');
      expect(String(failure.details), JSON.stringify(input)).toMatch(pattern);
    }
    expect(harness.environment.commandLog).toEqual([]);
  });
});
