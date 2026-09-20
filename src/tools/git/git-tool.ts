import { parseFail, parseOk, type ParseResult } from '../../domain/parse.js';
import type { Tool } from '../contracts.js';
import {
  COMMAND_OUTCOME_SCHEMA,
  runObservedCommand,
  type CommandOutcome,
} from '../support/command.js';
import {
  optionalInteger,
  optionalString,
  optionalStringArray,
  requireObject,
} from '../support/input.js';
import { clampTimeout, type ToolOptions } from '../support/options.js';
import { shellJoin } from '../support/shell.js';
import { resolveWorkspacePath } from '../support/workspace-path.js';

/**
 * Local git operations inside the sandbox. The allowlist is about *external
 * effects and credentials*, not about code execution (shell.run already
 * allows that): nothing here can push, and nothing can reconfigure git to
 * pick up credentials. Cloning is limited to http(s) URLs without embedded
 * credentials, so private repositories are simply unreachable until Phase 9
 * introduces an explicit GitHub capability.
 */
export const GIT_SUBCOMMANDS = [
  'init',
  'clone',
  'status',
  'log',
  'diff',
  'show',
  'add',
  'rm',
  'mv',
  'commit',
  'checkout',
  'switch',
  'branch',
  'tag',
  'rev-parse',
  'ls-files',
  'fetch',
  'pull',
  'remote',
  'stash',
  'reset',
  'restore',
  'merge',
  'rebase',
  'blame',
  'describe',
] as const;
export type GitSubcommand = (typeof GIT_SUBCOMMANDS)[number];

const FORBIDDEN_ARGUMENTS = [
  /^--?config(-env)?(=|$)/,
  /^-c$/,
  /^--exec-path/,
  /^--git-dir/,
  /^--work-tree/,
  /^--upload-pack/,
  /^--receive-pack/,
  /^--exec/,
  /^-u$/,
  /^--credential/,
];

const IDENTITY = ['-c', 'user.name=agent', '-c', 'user.email=agent@sandbox.invalid'];
const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' } as const;

export interface GitInput {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export function validateGitArgs(args: readonly string[]): ParseResult<readonly string[]> {
  if (args.length === 0) return parseFail('args must start with a git subcommand');
  const [subcommand, ...rest] = args;
  if (!(GIT_SUBCOMMANDS as readonly string[]).includes(subcommand ?? '')) {
    return parseFail(
      `git subcommand not allowed: ${subcommand}; allowed: ${GIT_SUBCOMMANDS.join(', ')}`,
    );
  }
  for (const argument of rest) {
    if (FORBIDDEN_ARGUMENTS.some((rule) => rule.test(argument))) {
      return parseFail(`git argument not allowed: ${argument}`);
    }
    if (argument.includes('\0')) return parseFail('git arguments must not contain NUL');
  }
  if (
    subcommand === 'clone' ||
    subcommand === 'remote' ||
    subcommand === 'fetch' ||
    subcommand === 'pull'
  ) {
    for (const argument of rest) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(argument) || argument.includes('@')) {
        let url: URL | undefined;
        try {
          url = new URL(argument);
        } catch {
          url = undefined;
        }
        if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
          return parseFail(`git remote URLs must be http(s): ${argument}`);
        }
        if (url.username !== '' || url.password !== '') {
          return parseFail('git remote URLs must not embed credentials');
        }
      }
    }
  }
  return parseOk(args);
}

export function createGitTool(options: ToolOptions): Tool<GitInput, CommandOutcome> {
  return {
    name: 'git',
    family: 'git',
    description: `Run a local git command inside the sandbox workspace (subcommands: ${GIT_SUBCOMMANDS.join(', ')}; no push).`,
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'git arguments, e.g. ["status", "--short"]',
        },
        cwd: { type: 'string', description: 'Repository directory inside the workspace' },
        timeoutMs: { type: 'integer' },
      },
      required: ['args'],
      additionalProperties: false,
    },
    outputSchema: COMMAND_OUTCOME_SCHEMA,
    parseInput(raw) {
      const object = requireObject(raw);
      if (!object.ok) return object;
      const errors: string[] = [];
      const args = optionalStringArray(object.value, 'args', errors);
      const cwdInput = optionalString(object.value, 'cwd', errors) ?? options.workspaceRoot;
      const timeout = optionalInteger(object.value, 'timeoutMs', errors, { min: 1 });
      if (errors.length > 0) return parseFail(...errors);
      const validated = validateGitArgs(args);
      if (!validated.ok) return validated;
      const cwd = resolveWorkspacePath(options.workspaceRoot, cwdInput);
      if (!cwd.ok) return cwd;
      return parseOk({
        args: validated.value,
        cwd: cwd.value,
        timeoutMs: clampTimeout(options, timeout),
      });
    },
    execute(input, context) {
      const command = shellJoin(['git', ...IDENTITY, ...input.args]);
      return runObservedCommand(context, options, command, {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        env: NO_PROMPT_ENV,
      });
    },
  };
}
