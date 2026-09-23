import { describe, expect, it } from 'vitest';
import { parseAgentArgs } from '../../src/cli/args.js';
import { parseDotEnv } from '../../src/cli/dotenv.js';
import {
  configuredSecrets,
  formatStartupBanner,
  resolveCliMemoryPath,
  resolveCliStartup,
} from '../../src/cli/config.js';
import { SecretRedactor } from '../../src/models/redaction.js';

const SECRET = 'gsk-test-secret-value-should-not-appear';

const modelEnv = {
  AGENT_MODEL_PROVIDER: 'openai-compatible',
  AGENT_MODEL_BASE_URL: 'https://api.groq.com/openai/v1',
  AGENT_MODEL_NAME: 'openai/gpt-oss-120b',
  AGENT_MODEL_API_KEY: SECRET,
};

function runArgs(argv: readonly string[]) {
  const parsed = parseAgentArgs(argv);
  if (parsed.kind !== 'run') throw new Error(`expected a run parse, got ${parsed.kind}`);
  return parsed.args;
}

describe('CLI configuration', () => {
  it('parses a dotenv file without keeping comments or expanding values', () => {
    expect(
      parseDotEnv(`
# comment
export AGENT_MODEL_NAME=openai/gpt-oss-120b
AGENT_MODEL_API_KEY="quoted-secret"
AGENT_MODEL_BASE_URL=https://api.groq.com/openai/v1
not a pair
`),
    ).toEqual({
      AGENT_MODEL_NAME: 'openai/gpt-oss-120b',
      AGENT_MODEL_API_KEY: 'quoted-secret',
      AGENT_MODEL_BASE_URL: 'https://api.groq.com/openai/v1',
    });
  });

  it('defaults memory to .agent under the working directory', () => {
    expect(resolveCliMemoryPath({}, '/work')).toBe('/work/.agent/memory.sqlite');
  });

  it('honours an explicit sqlite path and :memory:', () => {
    expect(resolveCliMemoryPath({ AGENT_MEMORY_PATH: 'var/mem.sqlite' }, '/work')).toBe(
      '/work/var/mem.sqlite',
    );
    expect(
      resolveCliMemoryPath(
        { AGENT_MEMORY_BACKEND: 'sqlite', AGENT_MEMORY_PATH: ':memory:' },
        '/work',
      ),
    ).toBe(':memory:');
  });

  it('refuses to start without a model and never puts the key in the banner', () => {
    expect(() => resolveCliStartup(runArgs(['a goal']), {}, '/work')).toThrow(
      /AGENT_MODEL_PROVIDER/,
    );
    const startup = resolveCliStartup(
      runArgs([
        'Create /workspace/hello.txt',
        '--require-file',
        '/workspace/hello.txt',
        '--require-marker',
        'AGENT_ALIVE',
      ]),
      modelEnv,
      '/work',
    );
    const banner = formatStartupBanner(startup, 'Docker (agent-sandbox-local:0.1.0)');
    expect(banner).toContain('Model: openai/gpt-oss-120b');
    expect(banner).toContain('Provider: openai-compatible');
    expect(banner).toContain('API key: configured');
    expect(banner).toContain('Memory: /work/.agent/memory.sqlite');
    expect(banner).toContain('Retrieval: on');
    expect(banner).toContain('lexical only');
    expect(banner).toContain('file_contains:/workspace/hello.txt|AGENT_ALIVE');
    expect(banner).not.toContain(SECRET);
    const redacted = new SecretRedactor(configuredSecrets(startup.model, startup.embedding)).redact(
      `leaked ${SECRET} tail`,
    );
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain('[REDACTED]');
  });
});
