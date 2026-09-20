import { parseFail, parseOk } from '../../domain/parse.js';
import type { Tool } from '../contracts.js';
import {
  COMMAND_OUTCOME_SCHEMA,
  runObservedCommand,
  type CommandOutcome,
} from '../support/command.js';
import {
  optionalInteger,
  optionalString,
  requireObject,
  requiredString,
} from '../support/input.js';
import { clampTimeout, type ToolOptions } from '../support/options.js';
import { resolveWorkspacePath } from '../support/workspace-path.js';

export interface ShellRunInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdin?: string;
}

/**
 * Runs a shell command inside the sandbox. The command string is passed to
 * the sandbox shell untouched; what confines it is the sandbox (non-root
 * user, no host mounts, resource limits), not this tool. Non-zero exit codes
 * and timeouts are returned as data so the evaluator can judge them.
 */
export function createShellRunTool(options: ToolOptions): Tool<ShellRunInput, CommandOutcome> {
  return {
    name: 'shell.run',
    family: 'terminal',
    description:
      'Run a shell command inside the isolated Linux sandbox and return exit code, stdout and stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'POSIX shell command line' },
        cwd: {
          type: 'string',
          description: 'Working directory inside the workspace (default: root)',
        },
        timeoutMs: {
          type: 'integer',
          description: `Kill the command after this many ms (default ${options.defaultTimeoutMs}, max ${options.maxTimeoutMs})`,
        },
        stdin: { type: 'string', description: 'Text to feed to standard input' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    outputSchema: COMMAND_OUTCOME_SCHEMA,
    parseInput(raw) {
      const object = requireObject(raw);
      if (!object.ok) return object;
      const errors: string[] = [];
      const command = requiredString(object.value, 'command', errors);
      const cwdInput = optionalString(object.value, 'cwd', errors) ?? options.workspaceRoot;
      const timeout = optionalInteger(object.value, 'timeoutMs', errors, { min: 1 });
      const stdin = optionalString(object.value, 'stdin', errors);
      if (errors.length > 0) return parseFail(...errors);
      const cwd = resolveWorkspacePath(options.workspaceRoot, cwdInput);
      if (!cwd.ok) return cwd;
      return parseOk({
        command,
        cwd: cwd.value,
        timeoutMs: clampTimeout(options, timeout),
        ...(stdin !== undefined ? { stdin } : {}),
      });
    },
    execute(input, context) {
      return runObservedCommand(context, options, input.command, {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      });
    },
  };
}
