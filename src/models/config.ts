import type { Clock, IdGenerator } from '../domain/ids.js';
import type { ModelProvider } from './contracts.js';
import type { EmbeddingProvider } from './embeddings.js';
import { ModelProviderError } from './errors.js';
import {
  OpenAICompatibleEmbeddingProvider,
  type OpenAICompatibleEmbeddingConfig,
} from './openai-compatible/embedding-provider.js';
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from './openai-compatible/provider.js';
import type { StructuredMode, ToolMode } from './openai-compatible/wire.js';

/**
 * Configuration-driven provider selection. The runtime never names a vendor;
 * the operator names an *endpoint*. One adapter kind exists today
 * (`openai-compatible`), which covers OpenAI, OpenRouter, Groq, Together,
 * Mistral, DeepSeek, Ollama, LM Studio, vLLM and llama.cpp servers. Further
 * kinds (e.g. a native Anthropic or Gemini wire format) are added here as new
 * union members without touching the runtime.
 *
 * Environment variables (all prefixed `AGENT_MODEL_`):
 *
 *   AGENT_MODEL_PROVIDER          `openai-compatible` (unset → no real model configured)
 *   AGENT_MODEL_BASE_URL          endpoint root, e.g. https://openrouter.ai/api/v1
 *   AGENT_MODEL_NAME              model identifier as the endpoint expects it
 *   AGENT_MODEL_API_KEY           secret; optional for keyless local servers
 *   AGENT_MODEL_LABEL             telemetry label, e.g. `openrouter` (default `openai-compatible`)
 *   AGENT_MODEL_TIMEOUT_MS        per-call deadline (default 60000)
 *   AGENT_MODEL_STRUCTURED_MODE   json_schema | json_object | prompt (default json_schema)
 *   AGENT_MODEL_TOOL_MODE         tools | json (default tools)
 *   AGENT_MODEL_EXTRA_HEADERS     JSON object of additional request headers (values treated as secrets)
 *   AGENT_MODEL_TEMPERATURE       default sampling temperature (unset → provider default)
 */
export type ModelProviderConfig =
  { readonly kind: 'none' } | ({ readonly kind: 'openai-compatible' } & OpenAICompatibleConfig);

export const MODEL_ENV = {
  provider: 'AGENT_MODEL_PROVIDER',
  baseUrl: 'AGENT_MODEL_BASE_URL',
  model: 'AGENT_MODEL_NAME',
  apiKey: 'AGENT_MODEL_API_KEY',
  label: 'AGENT_MODEL_LABEL',
  timeoutMs: 'AGENT_MODEL_TIMEOUT_MS',
  structuredMode: 'AGENT_MODEL_STRUCTURED_MODE',
  toolMode: 'AGENT_MODEL_TOOL_MODE',
  extraHeaders: 'AGENT_MODEL_EXTRA_HEADERS',
  temperature: 'AGENT_MODEL_TEMPERATURE',
} as const;

export type Environment = Readonly<Record<string, string | undefined>>;

const STRUCTURED_MODES: readonly StructuredMode[] = ['json_schema', 'json_object', 'prompt'];
const TOOL_MODES: readonly ToolMode[] = ['tools', 'json'];

export function resolveModelConfig(env: Environment): ModelProviderConfig {
  const provider = clean(env[MODEL_ENV.provider]);
  if (!provider) return { kind: 'none' };
  if (provider !== 'openai-compatible') {
    throw new ModelProviderError(
      `${MODEL_ENV.provider}="${provider}" is not a known provider kind (known: openai-compatible)`,
      'configuration',
    );
  }

  const baseUrl = clean(env[MODEL_ENV.baseUrl]);
  const model = clean(env[MODEL_ENV.model]);
  const missing = [...(baseUrl ? [] : [MODEL_ENV.baseUrl]), ...(model ? [] : [MODEL_ENV.model])];
  if (missing.length > 0 || !baseUrl || !model) {
    throw new ModelProviderError(
      `missing required variable(s): ${missing.join(', ')}`,
      'configuration',
    );
  }

  const apiKey = clean(env[MODEL_ENV.apiKey]);
  const label = clean(env[MODEL_ENV.label]);
  const timeoutMs = readPositiveInt(env, MODEL_ENV.timeoutMs) ?? DEFAULT_MODEL_TIMEOUT_MS;
  const structuredMode = readEnum(env, MODEL_ENV.structuredMode, STRUCTURED_MODES) ?? 'json_schema';
  const toolMode = readEnum(env, MODEL_ENV.toolMode, TOOL_MODES) ?? 'tools';
  const extraHeaders = readHeaders(env, MODEL_ENV.extraHeaders);
  const temperature = readNumber(env, MODEL_ENV.temperature);

  return {
    kind: 'openai-compatible',
    baseUrl,
    model,
    timeoutMs,
    structuredMode,
    toolMode,
    ...(apiKey ? { apiKey } : {}),
    ...(label ? { providerLabel: label } : {}),
    ...(extraHeaders ? { extraHeaders } : {}),
    ...(temperature !== undefined ? { defaultTemperature: temperature } : {}),
  };
}

export interface ModelConfigSummary {
  readonly kind: ModelProviderConfig['kind'];
  readonly providerLabel?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKeyConfigured: boolean;
  readonly structuredMode?: StructuredMode;
  readonly toolMode?: ToolMode;
  readonly timeoutMs?: number;
}

/** Safe to log and to show on the dashboard: says whether a key exists, never what it is. */
export function describeModelConfig(config: ModelProviderConfig): ModelConfigSummary {
  if (config.kind === 'none') return { kind: 'none', apiKeyConfigured: false };
  return {
    kind: config.kind,
    providerLabel: config.providerLabel ?? 'openai-compatible',
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyConfigured: config.apiKey !== undefined,
    structuredMode: config.structuredMode ?? 'json_schema',
    toolMode: config.toolMode ?? 'tools',
    timeoutMs: config.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
  };
}

export interface ProviderDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly fetch?: typeof fetch;
}

/** Instantiate the configured provider. `kind: 'none'` is a configuration error at this point. */
export function createModelProvider(
  config: ModelProviderConfig,
  deps: ProviderDeps,
): ModelProvider {
  switch (config.kind) {
    case 'none':
      throw new ModelProviderError(
        `no model provider configured: set ${MODEL_ENV.provider}, ${MODEL_ENV.baseUrl} and ${MODEL_ENV.model}`,
        'configuration',
      );
    case 'openai-compatible': {
      const { kind: _kind, ...rest } = config;
      return new OpenAICompatibleProvider(rest, deps);
    }
  }
}

// --------------------------------------------------------------- embeddings

/**
 * The embedding endpoint is configured separately from the chat model: it is
 * usually a different model, often a different server, and its absence must
 * be explicit — retrieval then runs lexically and says so. There is no
 * fallback to the chat model's endpoint: a semantic index silently built on
 * whatever model happened to be configured would be irreproducible.
 *
 *   AGENT_EMBEDDING_PROVIDER      `openai-compatible` (unset → no embedding model configured)
 *   AGENT_EMBEDDING_BASE_URL      endpoint root (same server as the chat model or another)
 *   AGENT_EMBEDDING_MODEL         embedding model identifier
 *   AGENT_EMBEDDING_API_KEY       secret; optional for keyless local servers
 *   AGENT_EMBEDDING_LABEL         telemetry label (default `openai-compatible`)
 *   AGENT_EMBEDDING_TIMEOUT_MS    per-call deadline (default 60000)
 *   AGENT_EMBEDDING_DIMENSIONS    requested vector size (unset → model's native size)
 *   AGENT_EMBEDDING_EXTRA_HEADERS JSON object of additional request headers (values treated as secrets)
 */
export type EmbeddingProviderConfig =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'openai-compatible' } & OpenAICompatibleEmbeddingConfig);

export const EMBEDDING_ENV = {
  provider: 'AGENT_EMBEDDING_PROVIDER',
  baseUrl: 'AGENT_EMBEDDING_BASE_URL',
  model: 'AGENT_EMBEDDING_MODEL',
  apiKey: 'AGENT_EMBEDDING_API_KEY',
  label: 'AGENT_EMBEDDING_LABEL',
  timeoutMs: 'AGENT_EMBEDDING_TIMEOUT_MS',
  dimensions: 'AGENT_EMBEDDING_DIMENSIONS',
  extraHeaders: 'AGENT_EMBEDDING_EXTRA_HEADERS',
} as const;

export function resolveEmbeddingConfig(env: Environment): EmbeddingProviderConfig {
  const provider = clean(env[EMBEDDING_ENV.provider]);
  if (!provider) return { kind: 'none' };
  if (provider !== 'openai-compatible') {
    throw new ModelProviderError(
      `${EMBEDDING_ENV.provider}="${provider}" is not a known provider kind (known: openai-compatible)`,
      'configuration',
    );
  }
  const baseUrl = clean(env[EMBEDDING_ENV.baseUrl]);
  const model = clean(env[EMBEDDING_ENV.model]);
  const missing = [
    ...(baseUrl ? [] : [EMBEDDING_ENV.baseUrl]),
    ...(model ? [] : [EMBEDDING_ENV.model]),
  ];
  if (missing.length > 0 || !baseUrl || !model) {
    throw new ModelProviderError(
      `missing required variable(s): ${missing.join(', ')}`,
      'configuration',
    );
  }
  const apiKey = clean(env[EMBEDDING_ENV.apiKey]);
  const label = clean(env[EMBEDDING_ENV.label]);
  const timeoutMs = readPositiveInt(env, EMBEDDING_ENV.timeoutMs) ?? DEFAULT_MODEL_TIMEOUT_MS;
  const dimensions = readPositiveInt(env, EMBEDDING_ENV.dimensions);
  const extraHeaders = readHeaders(env, EMBEDDING_ENV.extraHeaders);
  return {
    kind: 'openai-compatible',
    baseUrl,
    model,
    timeoutMs,
    ...(apiKey ? { apiKey } : {}),
    ...(label ? { providerLabel: label } : {}),
    ...(dimensions !== undefined ? { dimensions } : {}),
    ...(extraHeaders ? { extraHeaders } : {}),
  };
}

export interface EmbeddingConfigSummary {
  readonly kind: EmbeddingProviderConfig['kind'];
  readonly providerLabel?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKeyConfigured: boolean;
  readonly dimensions?: number;
  readonly timeoutMs?: number;
}

/** Safe to log: says whether a key exists, never what it is. */
export function describeEmbeddingConfig(config: EmbeddingProviderConfig): EmbeddingConfigSummary {
  if (config.kind === 'none') return { kind: 'none', apiKeyConfigured: false };
  return {
    kind: config.kind,
    providerLabel: config.providerLabel ?? 'openai-compatible',
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyConfigured: config.apiKey !== undefined,
    ...(config.dimensions !== undefined ? { dimensions: config.dimensions } : {}),
    timeoutMs: config.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
  };
}

export function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
  deps: ProviderDeps,
): EmbeddingProvider {
  switch (config.kind) {
    case 'none':
      throw new ModelProviderError(
        `no embedding provider configured: set ${EMBEDDING_ENV.provider}, ${EMBEDDING_ENV.baseUrl} and ${EMBEDDING_ENV.model}`,
        'configuration',
      );
    case 'openai-compatible': {
      const { kind: _kind, ...rest } = config;
      return new OpenAICompatibleEmbeddingProvider(rest, deps);
    }
  }
}

// ------------------------------------------------------------------ helpers

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readPositiveInt(env: Environment, name: string): number | undefined {
  const raw = clean(env[name]);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ModelProviderError(`${name} must be a positive integer`, 'configuration');
  }
  return value;
}

function readNumber(env: Environment, name: string): number | undefined {
  const raw = clean(env[name]);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new ModelProviderError(`${name} must be a number`, 'configuration');
  return value;
}

function readEnum<T extends string>(
  env: Environment,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const raw = clean(env[name]);
  if (raw === undefined) return undefined;
  if (!allowed.includes(raw as T)) {
    throw new ModelProviderError(`${name} must be one of ${allowed.join(', ')}`, 'configuration');
  }
  return raw as T;
}

function readHeaders(env: Environment, name: string): Readonly<Record<string, string>> | undefined {
  const raw = clean(env[name]);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelProviderError(`${name} must be a JSON object`, 'configuration');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ModelProviderError(`${name} must be a JSON object`, 'configuration');
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new ModelProviderError(`${name}: header "${key}" must be a string`, 'configuration');
    }
    headers[key.toLowerCase()] = value;
  }
  return headers;
}
