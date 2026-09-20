import { parseFail, parseOk, type ParseResult } from '../../domain/parse.js';
import type { DirectoryEntryType } from '../../sandbox/execution-environment.js';
import type { Tool, ToolContext } from '../contracts.js';
import { sandboxFileArtifact } from '../support/artifacts.js';
import {
  optionalInteger,
  optionalString,
  requireObject,
  requiredString,
} from '../support/input.js';
import { capText, utf8ByteLength } from '../support/output.js';
import type { ToolOptions } from '../support/options.js';
import { resolveWorkspacePath } from '../support/workspace-path.js';

/**
 * Filesystem tools. Every path is resolved under the workspace root and every
 * byte moves through `ToolContext.environment` — never Node's `fs`. They
 * report what the sandbox reported; whether a file's *content* is right is
 * the evaluator's question, not theirs.
 */

export interface FsReadInput {
  readonly path: string;
  readonly maxChars?: number;
}
export interface FsReadOutput {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly sizeChars: number;
}

export interface FsWriteInput {
  readonly path: string;
  readonly content: string;
}
export interface FsWriteOutput {
  readonly path: string;
  readonly bytes: number;
  readonly created: boolean;
}

export interface FsListInput {
  readonly path: string;
}
export interface FsListEntry {
  readonly name: string;
  readonly type: DirectoryEntryType;
  readonly sizeBytes?: number;
}
export interface FsListOutput {
  readonly path: string;
  readonly entries: readonly FsListEntry[];
  readonly truncated: boolean;
  readonly totalEntries: number;
}

export interface FsDeleteInput {
  readonly path: string;
}
export interface FsDeleteOutput {
  readonly path: string;
  readonly deleted: true;
}

const MAX_LIST_ENTRIES = 500;

function parsePath(
  options: ToolOptions,
  raw: unknown,
): ParseResult<Record<string, unknown> & { path: string }> {
  const object = requireObject(raw);
  if (!object.ok) return object;
  const errors: string[] = [];
  const path = requiredString(object.value, 'path', errors);
  if (errors.length > 0) return parseFail(...errors);
  const resolved = resolveWorkspacePath(options.workspaceRoot, path);
  if (!resolved.ok) return resolved;
  return parseOk({ ...object.value, path: resolved.value });
}

export function createFsReadTool(options: ToolOptions): Tool<FsReadInput, FsReadOutput> {
  return {
    name: 'fs.read',
    family: 'filesystem',
    description: 'Read a UTF-8 text file from the sandbox workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the workspace' },
        maxChars: { type: 'integer', description: 'Optional cap on returned characters' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        truncated: { type: 'boolean' },
        sizeChars: { type: 'integer' },
      },
    },
    parseInput(raw) {
      const base = parsePath(options, raw);
      if (!base.ok) return base;
      const errors: string[] = [];
      const maxChars = optionalInteger(base.value, 'maxChars', errors, { min: 1 });
      if (errors.length > 0) return parseFail(...errors);
      return parseOk({ path: base.value.path, ...(maxChars !== undefined ? { maxChars } : {}) });
    },
    async execute(input, context) {
      const content = await context.environment.readFile(input.path);
      const cap = Math.min(options.maxOutputChars, input.maxChars ?? options.maxOutputChars);
      const capped = capText(content, cap);
      return {
        path: input.path,
        content: capped.text,
        truncated: capped.truncated,
        sizeChars: capped.originalLength,
      };
    },
  };
}

export function createFsWriteTool(options: ToolOptions): Tool<FsWriteInput, FsWriteOutput> {
  return {
    name: 'fs.write',
    family: 'filesystem',
    description:
      'Create or overwrite a UTF-8 text file in the sandbox workspace (parent directories are created).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the workspace' },
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        bytes: { type: 'integer' },
        created: { type: 'boolean', description: 'false when an existing file was overwritten' },
      },
    },
    parseInput(raw) {
      const base = parsePath(options, raw);
      if (!base.ok) return base;
      const errors: string[] = [];
      const content = requiredString(base.value, 'content', errors, { allowEmpty: true });
      if (errors.length > 0) return parseFail(...errors);
      return parseOk({ path: base.value.path, content });
    },
    async execute(input, context) {
      const existed = await context.environment.fileExists(input.path);
      await context.environment.writeFile(input.path, input.content);
      const bytes = utf8ByteLength(input.content);
      context.emit(existed ? 'FILE_CHANGED' : 'FILE_CREATED', {
        path: input.path,
        sizeBytes: bytes,
      });
      return { path: input.path, bytes, created: !existed };
    },
    artifacts(input, output, context: ToolContext) {
      return [
        sandboxFileArtifact(context, input.path, {
          sizeBytes: output.bytes,
          description: `${output.created ? 'Created' : 'Overwrote'} ${input.path} (${output.bytes} bytes)`,
        }),
      ];
    },
  };
}

export function createFsListTool(options: ToolOptions): Tool<FsListInput, FsListOutput> {
  return {
    name: 'fs.list',
    family: 'filesystem',
    description: 'List the entries of a directory in the sandbox workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory path, absolute or relative to the workspace; defaults to the workspace root',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['file', 'directory', 'symlink', 'other'] },
              sizeBytes: { type: 'integer' },
            },
          },
        },
        truncated: { type: 'boolean' },
        totalEntries: { type: 'integer' },
      },
    },
    parseInput(raw) {
      const object = requireObject(raw);
      if (!object.ok) return object;
      const errors: string[] = [];
      const path = optionalString(object.value, 'path', errors) ?? options.workspaceRoot;
      if (errors.length > 0) return parseFail(...errors);
      const resolved = resolveWorkspacePath(options.workspaceRoot, path);
      if (!resolved.ok) return resolved;
      return parseOk({ path: resolved.value });
    },
    async execute(input, context) {
      const entries = await context.environment.listDirectory(input.path);
      const shown = entries.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
        name: entry.name,
        type: entry.type,
        ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
      }));
      return {
        path: input.path,
        entries: shown,
        truncated: entries.length > shown.length,
        totalEntries: entries.length,
      };
    },
  };
}

export function createFsDeleteTool(options: ToolOptions): Tool<FsDeleteInput, FsDeleteOutput> {
  return {
    name: 'fs.delete',
    family: 'filesystem',
    description: 'Delete a file in the sandbox workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the workspace' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, deleted: { type: 'boolean' } },
    },
    parseInput(raw) {
      const base = parsePath(options, raw);
      if (!base.ok) return base;
      if (base.value.path === options.workspaceRoot) {
        return parseFail('refusing to delete the workspace root');
      }
      return parseOk({ path: base.value.path });
    },
    async execute(input, context) {
      await context.environment.deleteFile(input.path);
      context.emit('FILE_DELETED', { path: input.path });
      return { path: input.path, deleted: true };
    },
  };
}

export function createFilesystemTools(options: ToolOptions): readonly Tool<unknown, unknown>[] {
  return [
    createFsReadTool(options),
    createFsWriteTool(options),
    createFsListTool(options),
    createFsDeleteTool(options),
  ] as readonly Tool<unknown, unknown>[];
}
