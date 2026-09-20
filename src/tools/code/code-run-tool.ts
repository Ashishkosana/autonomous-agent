import { parseFail, parseOk } from '../../domain/parse.js';
import type { Tool, ToolContext } from '../contracts.js';
import { sandboxFileArtifact } from '../support/artifacts.js';
import {
  COMMAND_OUTCOME_SCHEMA,
  runObservedCommand,
  type CommandOutcome,
} from '../support/command.js';
import {
  optionalEnum,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requireObject,
  requiredString,
} from '../support/input.js';
import { clampTimeout, type ToolOptions } from '../support/options.js';
import { utf8ByteLength } from '../support/output.js';
import { shellJoin } from '../support/shell.js';

export const CODE_LANGUAGES = ['python', 'node', 'sh'] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

const INTERPRETERS: Record<
  CodeLanguage,
  { readonly argv: readonly string[]; readonly ext: string }
> = {
  python: { argv: ['python3'], ext: 'py' },
  node: { argv: ['node'], ext: 'js' },
  sh: { argv: ['sh'], ext: 'sh' },
};

export interface CodeRunInput {
  readonly language: CodeLanguage;
  readonly source: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly stdin?: string;
}

export interface CodeRunOutput extends CommandOutcome {
  readonly language: CodeLanguage;
  readonly sourcePath: string;
}

/**
 * Writes a program into the workspace scratch directory and runs it with the
 * sandbox's interpreter. The program text is a real artifact of the run; its
 * exit code and output are observations. An exit code of 0 says the program
 * ran, not that it computed the right thing.
 */
export function createCodeRunTool(options: ToolOptions): Tool<CodeRunInput, CodeRunOutput> {
  return {
    name: 'code.run',
    family: 'code',
    description:
      'Save a program (python, node or sh) into the sandbox and execute it; returns exit code, stdout and stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: [...CODE_LANGUAGES] },
        source: { type: 'string', description: 'Complete program source' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments' },
        timeoutMs: { type: 'integer', description: `Max ${options.maxTimeoutMs}` },
        stdin: { type: 'string' },
      },
      required: ['language', 'source'],
      additionalProperties: false,
    },
    outputSchema: {
      ...COMMAND_OUTCOME_SCHEMA,
      properties: {
        ...COMMAND_OUTCOME_SCHEMA.properties,
        language: { type: 'string' },
        sourcePath: { type: 'string' },
      },
    },
    parseInput(raw) {
      const object = requireObject(raw);
      if (!object.ok) return object;
      const errors: string[] = [];
      const language = optionalEnum(object.value, 'language', CODE_LANGUAGES, errors);
      if (language === undefined && errors.length === 0) errors.push('language is required');
      const source = requiredString(object.value, 'source', errors);
      const args = optionalStringArray(object.value, 'args', errors);
      const timeout = optionalInteger(object.value, 'timeoutMs', errors, { min: 1 });
      const stdin = optionalString(object.value, 'stdin', errors);
      if (errors.length > 0 || language === undefined) return parseFail(...errors);
      return parseOk({
        language,
        source,
        args,
        timeoutMs: clampTimeout(options, timeout),
        ...(stdin !== undefined ? { stdin } : {}),
      });
    },
    async execute(input, context) {
      const interpreter = INTERPRETERS[input.language];
      const sourcePath = `${options.workspaceRoot}/${options.scratchDir}/code/${context.actionId}.${interpreter.ext}`;
      await context.environment.writeFile(sourcePath, input.source);
      context.emit('FILE_CREATED', { path: sourcePath, sizeBytes: utf8ByteLength(input.source) });
      const command = shellJoin([...interpreter.argv, sourcePath, ...input.args]);
      const outcome = await runObservedCommand(context, options, command, {
        cwd: options.workspaceRoot,
        timeoutMs: input.timeoutMs,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      });
      return { ...outcome, language: input.language, sourcePath };
    },
    artifacts(input, output, context: ToolContext) {
      return [
        sandboxFileArtifact(context, output.sourcePath, {
          kind: 'code',
          sizeBytes: utf8ByteLength(input.source),
          description: `${input.language} program executed with exit code ${output.exitCode}`,
        }),
      ];
    },
  };
}
