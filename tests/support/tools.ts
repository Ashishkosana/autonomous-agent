import { parseFail, parseOk, type ParseResult } from '../../src/domain/parse.js';
import type { Tool, ToolContext } from '../../src/tools/contracts.js';

export interface EchoInput {
  readonly message: string;
}

/** Minimal well-behaved tool. */
export const echoTool: Tool<EchoInput, { echoed: string }> = {
  name: 'echo',
  family: 'introspection',
  description: 'Returns its input. Used only in tests.',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
  outputSchema: { type: 'object', properties: { echoed: { type: 'string' } } },
  parseInput(input: unknown): ParseResult<EchoInput> {
    if (typeof input === 'object' && input !== null && 'message' in input) {
      const message = (input as { message: unknown }).message;
      if (typeof message === 'string') return parseOk({ message });
    }
    return parseFail('expected { message: string }');
  },
  async execute(input) {
    return { echoed: input.message };
  },
};

export interface WriteFileInput {
  readonly path: string;
  readonly content: string;
}

/** Writes through the ExecutionEnvironment handed to it — never to the host. */
export const writeFileTool: Tool<WriteFileInput, { path: string; bytes: number }> = {
  name: 'fs.write',
  family: 'filesystem',
  description: 'Write a text file inside the sandbox workspace. Used only in tests.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  outputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, bytes: { type: 'integer' } },
  },
  parseInput(input: unknown): ParseResult<WriteFileInput> {
    if (typeof input !== 'object' || input === null) return parseFail('expected object');
    const { path, content } = input as { path?: unknown; content?: unknown };
    const errors: string[] = [];
    if (typeof path !== 'string' || path.length === 0)
      errors.push('path must be a non-empty string');
    if (typeof content !== 'string') errors.push('content must be a string');
    if (errors.length > 0) return parseFail(...errors);
    return parseOk({ path: path as string, content: content as string });
  },
  async execute(input, context: ToolContext) {
    await context.environment.writeFile(input.path, input.content);
    return { path: input.path, bytes: input.content.length };
  },
};

/** Always throws, to prove the registry converts exceptions into structured errors. */
export const explodingTool: Tool<Record<string, never>, never> = {
  name: 'explode',
  family: 'introspection',
  description: 'Throws on execute. Used only in tests.',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'null' },
  parseInput() {
    return parseOk({});
  },
  async execute() {
    throw new Error('boom');
  },
};
