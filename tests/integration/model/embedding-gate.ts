import { describe } from 'vitest';
import {
  describeEmbeddingConfig,
  resolveEmbeddingConfig,
  type EmbeddingConfigSummary,
  type EmbeddingProviderConfig,
} from '../../../src/models/config.js';
import { ModelProviderError } from '../../../src/models/errors.js';

/**
 * Gate for tests that call a REAL embedding endpoint (Phase 7).
 *
 * - Default (`npm test`): SKIPPED unless `AGENT_EMBEDDING_PROVIDER` and the
 *   endpoint variables are set. No fake is substituted.
 * - AGENT_REQUIRE_REAL_EMBEDDING=1: the endpoint MUST be configured or the
 *   file FAILS at load with the exact variables to set.
 *
 * Deliberately separate from the chat-model gate: an operator may have one
 * without the other, and a green chat suite must never imply that semantic
 * retrieval was exercised against a real model.
 */
const required = process.env['AGENT_REQUIRE_REAL_EMBEDDING'] === '1';

function probe(): { ok: true; config: EmbeddingProviderConfig } | { ok: false; reason: string } {
  let config: EmbeddingProviderConfig;
  try {
    config = resolveEmbeddingConfig(process.env);
  } catch (error) {
    const detail = error instanceof ModelProviderError ? error.message : String(error);
    return { ok: false, reason: `embedding configuration invalid — ${detail}` };
  }
  if (config.kind === 'none') {
    return {
      ok: false,
      reason:
        'AGENT_EMBEDDING_PROVIDER not set (set AGENT_EMBEDDING_PROVIDER=openai-compatible, AGENT_EMBEDDING_BASE_URL, AGENT_EMBEDDING_MODEL and, if the endpoint needs one, AGENT_EMBEDDING_API_KEY)',
    };
  }
  return { ok: true, config };
}

const gate = probe();

export const REAL_EMBEDDING_AVAILABLE = gate.ok;
export const EMBEDDING_CONFIG: EmbeddingProviderConfig | undefined = gate.ok
  ? gate.config
  : undefined;
export const EMBEDDING_SUMMARY: EmbeddingConfigSummary | undefined = gate.ok
  ? describeEmbeddingConfig(gate.config)
  : undefined;
export const EMBEDDING_SKIP_REASON = gate.ok
  ? ''
  : `real-embedding verification NOT RUN — ${gate.reason}`;

if (!gate.ok) {
  if (required) {
    throw new Error(`${EMBEDDING_SKIP_REASON}. Refusing to pass without a real embedding model.`);
  }
  console.warn(`[skip] ${EMBEDDING_SKIP_REASON}`);
}

export const describeRealEmbedding = describe.skipIf(!gate.ok);
