import type { CommandResult } from '../../sandbox/execution-environment.js';
import type { ToolContext } from '../contracts.js';
import { capText } from './output.js';
import type { ToolOptions } from './options.js';

/** What every command-running tool reports back. Exit codes are data, not errors. */
export interface CommandOutcome {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ObservedCommandOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** Event payloads are for the dashboard; they get a shorter cap than tool outputs. */
const EVENT_CHUNK_CHARS = 2_000;

/**
 * Runs one shell command through the sandbox and narrates it with
 * COMMAND_STARTED / COMMAND_OUTPUT / COMMAND_FINISHED so the dashboard can
 * show what ran and what came back, independently of the tool's own output.
 */
export async function runObservedCommand(
  context: ToolContext,
  toolOptions: ToolOptions,
  command: string,
  options: ObservedCommandOptions,
): Promise<CommandOutcome> {
  context.emit('COMMAND_STARTED', { command, cwd: options.cwd });
  const result: CommandResult = await context.environment.runCommand(command, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  if (result.stdout.length > 0) {
    context.emit('COMMAND_OUTPUT', {
      stream: 'stdout',
      chunk: capText(result.stdout, EVENT_CHUNK_CHARS).text,
    });
  }
  if (result.stderr.length > 0) {
    context.emit('COMMAND_OUTPUT', {
      stream: 'stderr',
      chunk: capText(result.stderr, EVENT_CHUNK_CHARS).text,
    });
  }
  context.emit('COMMAND_FINISHED', {
    command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  });
  const stdout = capText(result.stdout, toolOptions.maxOutputChars);
  const stderr = capText(result.stderr, toolOptions.maxOutputChars);
  return {
    command,
    cwd: options.cwd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

/** JSON-schema fragment shared by the command-shaped tool outputs. */
export const COMMAND_OUTCOME_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    cwd: { type: 'string' },
    exitCode: { type: 'integer', description: 'null when the process was killed (timeout)' },
    timedOut: { type: 'boolean' },
    durationMs: { type: 'integer' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    stdoutTruncated: { type: 'boolean' },
    stderrTruncated: { type: 'boolean' },
  },
} as const;
