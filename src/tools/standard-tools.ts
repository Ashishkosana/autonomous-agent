import { createCodeRunTool } from './code/code-run-tool.js';
import type { Tool } from './contracts.js';
import { createFilesystemTools } from './filesystem/filesystem-tools.js';
import { createGitTool } from './git/git-tool.js';
import { createHttpRequestTool } from './http/http-request-tool.js';
import { ToolRegistry } from './registry.js';
import { resolveToolOptions, type ToolOptions } from './support/options.js';
import { createShellRunTool } from './terminal/shell-run-tool.js';
import { createWebSearchTool, type SearchProvider } from './web/search-provider.js';
import { createWebFetchTool } from './web/web-fetch-tool.js';

export type StandardToolFamily = 'filesystem' | 'terminal' | 'code' | 'http' | 'web' | 'git';

export const STANDARD_TOOL_FAMILIES: readonly StandardToolFamily[] = [
  'filesystem',
  'terminal',
  'code',
  'http',
  'web',
  'git',
];

export interface StandardToolsConfig {
  readonly options?: Partial<ToolOptions>;
  /**
   * Which families the run may use. Registration IS the permission model:
   * a tool that is not registered cannot be selected, validated or invoked,
   * and the model is never told it exists. Defaults to every family.
   */
  readonly families?: readonly StandardToolFamily[];
  /** Enables `web.search`; without a provider the tool is not registered. */
  readonly searchProvider?: SearchProvider;
}

/** The real V1 tool set, built for one workspace with one set of limits. */
export function createStandardTools(config: StandardToolsConfig = {}): Tool<unknown, unknown>[] {
  const options = resolveToolOptions(config.options);
  const families = new Set(config.families ?? STANDARD_TOOL_FAMILIES);
  const tools: Tool<unknown, unknown>[] = [];
  // Tools are invariant in their input type only nominally; the registry erases it the same way.
  const add = <TInput, TOutput>(tool: Tool<TInput, TOutput>) =>
    tools.push(tool as unknown as Tool<unknown, unknown>);
  if (families.has('filesystem')) tools.push(...createFilesystemTools(options));
  if (families.has('terminal')) add(createShellRunTool(options));
  if (families.has('code')) add(createCodeRunTool(options));
  if (families.has('http')) add(createHttpRequestTool(options));
  if (families.has('web')) {
    add(createWebFetchTool(options));
    if (config.searchProvider) add(createWebSearchTool(config.searchProvider));
  }
  if (families.has('git')) add(createGitTool(options));
  return tools;
}

export function createStandardToolRegistry(config: StandardToolsConfig = {}): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createStandardTools(config)) registry.register(tool);
  return registry;
}
