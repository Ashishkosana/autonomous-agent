import { describe, expect, it } from 'vitest';
import { parseAgentArgs } from '../../src/cli/args.js';

describe('parseAgentArgs', () => {
  it('shows help without requiring a goal', () => {
    expect(parseAgentArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseAgentArgs(['-h', 'ignored'])).toEqual({ kind: 'help' });
  });

  it('joins a positional goal and leaves criteria empty', () => {
    const parsed = parseAgentArgs(['Create', 'a', 'file']);
    expect(parsed).toMatchObject({
      kind: 'run',
      args: {
        goalStatement: 'Create a file',
        constraints: [],
        verifiableCriteria: [],
        memoryRetrieval: 'on',
      },
    });
  });

  it('pairs a marker with the preceding required file', () => {
    const parsed = parseAgentArgs([
      '--require-file',
      '/workspace/hello.txt',
      '--require-marker',
      'AGENT_ALIVE',
      'Create /workspace/hello.txt containing exactly AGENT_ALIVE',
    ]);
    expect(parsed).toMatchObject({
      kind: 'run',
      args: {
        verifiableCriteria: [
          { kind: 'file_contains', path: '/workspace/hello.txt', marker: 'AGENT_ALIVE' },
        ],
      },
    });
  });

  it('accepts the production criterion grammar and a second file', () => {
    const parsed = parseAgentArgs([
      'ship it',
      '--criterion',
      'command_exits_zero:python3 /workspace/check.py',
      '--require-file',
      '/workspace/a.txt',
      '--require-file=/workspace/b.txt',
      '--memory',
      'off',
      '--constraint',
      'use Python',
    ]);
    expect(parsed).toEqual({
      kind: 'run',
      args: {
        goalStatement: 'ship it',
        constraints: ['use Python'],
        memoryRetrieval: 'off',
        verifiableCriteria: [
          { kind: 'command_exits_zero', command: 'python3 /workspace/check.py' },
          { kind: 'file_exists', path: '/workspace/a.txt' },
          { kind: 'file_exists', path: '/workspace/b.txt' },
        ],
      },
    });
  });

  it('rejects a marker with no file, a bad criterion, and a missing goal', () => {
    expect(parseAgentArgs(['--require-marker', 'X', 'goal']).kind).toBe('error');
    expect(parseAgentArgs(['--criterion', 'please succeed', 'goal']).kind).toBe('error');
    expect(parseAgentArgs([])).toMatchObject({ kind: 'error' });
    expect(parseAgentArgs(['--unknown', 'goal']).kind).toBe('error');
  });
});
