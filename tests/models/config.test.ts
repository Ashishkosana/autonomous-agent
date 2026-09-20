import { describe, expect, it } from 'vitest';
import {
  MODEL_ENV,
  createModelProvider,
  describeModelConfig,
  resolveModelConfig,
} from '../../src/models/config.js';
import { ModelProviderError } from '../../src/models/errors.js';
import { OpenAICompatibleProvider } from '../../src/models/openai-compatible/provider.js';
import { FixedClock, SequentialIdGenerator } from '../support/deterministic.js';

const KEY = 'sk-live-0123456789abcdef0123456789abcdef';
const minimal = {
  [MODEL_ENV.provider]: 'openai-compatible',
  [MODEL_ENV.baseUrl]: 'https://openrouter.ai/api/v1',
  [MODEL_ENV.model]: 'some-vendor/some-model:free',
};

describe('model configuration', () => {
  it('is "none" when no provider is named, so the runtime can fall back or refuse explicitly', () => {
    expect(resolveModelConfig({})).toEqual({ kind: 'none' });
    expect(resolveModelConfig({ [MODEL_ENV.provider]: '  ' })).toEqual({ kind: 'none' });
    expect(() => createModelProvider({ kind: 'none' }, deps())).toThrow(ModelProviderError);
  });

  it('resolves an openai-compatible endpoint from the environment with sensible defaults', () => {
    expect(resolveModelConfig(minimal)).toEqual({
      kind: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'some-vendor/some-model:free',
      timeoutMs: 60_000,
      structuredMode: 'json_schema',
      toolMode: 'tools',
    });
  });

  it('reads every optional knob and normalises header names', () => {
    const config = resolveModelConfig({
      ...minimal,
      [MODEL_ENV.apiKey]: ` ${KEY} `,
      [MODEL_ENV.label]: 'openrouter',
      [MODEL_ENV.timeoutMs]: '15000',
      [MODEL_ENV.structuredMode]: 'json_object',
      [MODEL_ENV.toolMode]: 'json',
      [MODEL_ENV.extraHeaders]: '{"HTTP-Referer":"https://example.test","X-Title":"agent"}',
      [MODEL_ENV.temperature]: '0.3',
    });
    expect(config).toEqual({
      kind: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'some-vendor/some-model:free',
      apiKey: KEY,
      providerLabel: 'openrouter',
      timeoutMs: 15_000,
      structuredMode: 'json_object',
      toolMode: 'json',
      extraHeaders: { 'http-referer': 'https://example.test', 'x-title': 'agent' },
      defaultTemperature: 0.3,
    });
  });

  it('fails loudly on unknown kinds, missing variables and malformed values — without echoing secrets', () => {
    const cases: Record<string, string | undefined>[] = [
      { [MODEL_ENV.provider]: 'anthropic-native' },
      { [MODEL_ENV.provider]: 'openai-compatible', [MODEL_ENV.apiKey]: KEY },
      { ...minimal, [MODEL_ENV.timeoutMs]: 'soon' },
      { ...minimal, [MODEL_ENV.structuredMode]: 'yaml' },
      { ...minimal, [MODEL_ENV.toolMode]: 'magic' },
      { ...minimal, [MODEL_ENV.extraHeaders]: 'not json' },
      { ...minimal, [MODEL_ENV.extraHeaders]: '["a"]' },
      { ...minimal, [MODEL_ENV.extraHeaders]: '{"x":1}' },
      { ...minimal, [MODEL_ENV.temperature]: 'hot' },
    ];
    for (const env of cases) {
      let thrown: unknown;
      try {
        resolveModelConfig({ ...env, [MODEL_ENV.apiKey]: env[MODEL_ENV.apiKey] ?? KEY });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ModelProviderError);
      expect((thrown as ModelProviderError).kind).toBe('configuration');
      expect((thrown as ModelProviderError).message).not.toContain(KEY);
    }
    expect(() => resolveModelConfig({ [MODEL_ENV.provider]: 'openai-compatible' })).toThrow(
      /AGENT_MODEL_BASE_URL, AGENT_MODEL_NAME/,
    );
  });

  it('describes the configuration safely: whether a key exists, never its value', () => {
    const summary = describeModelConfig(
      resolveModelConfig({ ...minimal, [MODEL_ENV.apiKey]: KEY }),
    );
    expect(summary).toEqual({
      kind: 'openai-compatible',
      providerLabel: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'some-vendor/some-model:free',
      apiKeyConfigured: true,
      structuredMode: 'json_schema',
      toolMode: 'tools',
      timeoutMs: 60_000,
    });
    expect(JSON.stringify(summary)).not.toContain(KEY);
    expect(describeModelConfig({ kind: 'none' })).toEqual({
      kind: 'none',
      apiKeyConfigured: false,
    });
  });

  it('instantiates the adapter for the configured kind', () => {
    const provider = createModelProvider(
      resolveModelConfig({ ...minimal, [MODEL_ENV.label]: 'openrouter' }),
      deps(),
    );
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.descriptor).toEqual({
      provider: 'openrouter',
      model: 'some-vendor/some-model:free',
    });
  });
});

function deps() {
  return { clock: new FixedClock(), ids: new SequentialIdGenerator() };
}
