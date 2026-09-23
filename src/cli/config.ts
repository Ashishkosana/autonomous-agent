import { isAbsolute, resolve } from 'node:path';
import type { VerifiableCriterion } from '../domain/criteria.js';
import type { RunLimits } from '../domain/run.js';
import { resolveMemoryConfig, type Environment } from '../memory/config.js';
import {
  describeEmbeddingConfig,
  describeModelConfig,
  resolveEmbeddingConfig,
  resolveModelConfig,
  type EmbeddingProviderConfig,
  type ModelProviderConfig,
} from '../models/config.js';
import type { ParsedAgentArgs } from './args.js';
import { DEFAULT_CLI_LIMITS } from './limits.js';

/** Git-ignored directory the CLI uses when AGENT_MEMORY_* is unset. */
export const CLI_DEFAULT_MEMORY_RELATIVE = '.agent/memory.sqlite';

export interface CliStartup {
  readonly goalStatement: string;
  readonly constraints: readonly string[];
  readonly verifiableCriteria: readonly VerifiableCriterion[];
  readonly memoryRetrieval: 'on' | 'off';
  readonly memoryPath: string;
  readonly model: ModelProviderConfig;
  readonly embedding: EmbeddingProviderConfig;
  readonly limits: RunLimits;
}

/**
 * Combines parsed arguments with the existing model, embedding, and memory
 * resolvers. The memory file defaults to `.agent/memory.sqlite` under `cwd`
 * only for the CLI. `resolveMemoryConfig` itself still treats an unset
 * backend as "no store", so tests and other composition roots are unchanged.
 */
export function resolveCliStartup(
  args: ParsedAgentArgs,
  env: Environment,
  cwd: string,
): CliStartup {
  const model = resolveModelConfig(env);
  if (model.kind === 'none') {
    throw new Error(
      'No model provider configured. Set AGENT_MODEL_PROVIDER, AGENT_MODEL_BASE_URL, and AGENT_MODEL_NAME in the environment or in .env (see .env.example). The API key is never printed.',
    );
  }
  return {
    goalStatement: args.goalStatement,
    constraints: args.constraints,
    verifiableCriteria: args.verifiableCriteria,
    memoryRetrieval: args.memoryRetrieval,
    memoryPath: resolveCliMemoryPath(env, cwd),
    model,
    embedding: resolveEmbeddingConfig(env),
    limits: DEFAULT_CLI_LIMITS,
  };
}

export function resolveCliMemoryPath(env: Environment, cwd: string): string {
  const backend = env['AGENT_MEMORY_BACKEND']?.trim() ?? '';
  const configuredPath = env['AGENT_MEMORY_PATH']?.trim() ?? '';
  if (backend === '' && configuredPath === '') return resolve(cwd, CLI_DEFAULT_MEMORY_RELATIVE);
  const configured = resolveMemoryConfig({
    AGENT_MEMORY_BACKEND: backend === '' ? 'sqlite' : backend,
    AGENT_MEMORY_PATH: configuredPath === '' ? undefined : configuredPath,
  });
  if (configured.kind !== 'sqlite') {
    throw new Error('memory configuration did not resolve to sqlite');
  }
  if (configured.path === ':memory:') return configured.path;
  return isAbsolute(configured.path) ? configured.path : resolve(cwd, configured.path);
}

/** Values the redactor must hide. The banner and event renderer never print these. */
export function configuredSecrets(
  model: ModelProviderConfig,
  embedding: EmbeddingProviderConfig,
): readonly string[] {
  const secrets: string[] = [];
  if (model.kind === 'openai-compatible') {
    if (model.apiKey) secrets.push(model.apiKey);
    if (model.extraHeaders) secrets.push(...Object.values(model.extraHeaders));
  }
  if (embedding.kind === 'openai-compatible') {
    if (embedding.apiKey) secrets.push(embedding.apiKey);
    if (embedding.extraHeaders) secrets.push(...Object.values(embedding.extraHeaders));
  }
  return secrets;
}

/** CLI chrome printed before the run. It is not an agent event. */
export function formatStartupBanner(startup: CliStartup, environmentLabel: string): string {
  const model = describeModelConfig(startup.model);
  const embedding = describeEmbeddingConfig(startup.embedding);
  const embeddingLine =
    embedding.kind === 'none'
      ? 'lexical only (no embedding endpoint)'
      : `${embedding.model ?? 'configured'} (${embedding.providerLabel ?? embedding.kind})`;
  return [
    '🔥 AUTONOMOUS AGENT',
    '',
    `Model: ${model.model ?? 'not configured'}`,
    `Provider: ${model.providerLabel ?? model.kind}`,
    `API key: ${model.apiKeyConfigured ? 'configured' : 'not set'}`,
    `Environment: ${environmentLabel}`,
    `Memory: ${startup.memoryPath}`,
    `Retrieval: ${startup.memoryRetrieval}`,
    `Embeddings: ${embeddingLine}`,
    criteriaLine(startup.verifiableCriteria),
  ].join('\n');
}

function criteriaLine(criteria: readonly VerifiableCriterion[]): string {
  if (criteria.length === 0) {
    return 'Criteria: none. Without a mechanical criterion the evaluator reports inconclusive and will not call the goal a success.';
  }
  return `Criteria: ${criteria.map(formatCriterion).join('; ')}`;
}

function formatCriterion(criterion: VerifiableCriterion): string {
  switch (criterion.kind) {
    case 'file_exists':
      return `file_exists:${criterion.path}`;
    case 'file_contains':
      return `file_contains:${criterion.path}|${criterion.marker}`;
    case 'json_file':
      return criterion.requiredKeys && criterion.requiredKeys.length > 0
        ? `json_file:${criterion.path}|${criterion.requiredKeys.join(',')}`
        : `json_file:${criterion.path}`;
    case 'command_exits_zero':
      return `command_exits_zero:${criterion.command}`;
    case 'http_status':
      return `http_status:${criterion.status}`;
    case 'tool_succeeded':
      return criterion.toolName ? `tool_succeeded:${criterion.toolName}` : 'tool_succeeded';
  }
}
