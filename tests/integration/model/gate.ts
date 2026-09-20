import { describe, vi } from 'vitest';
import {
  describeModelConfig,
  resolveModelConfig,
  type ModelConfigSummary,
  type ModelProviderConfig,
} from '../../../src/models/config.js';
import { ModelProviderError } from '../../../src/models/errors.js';
import { recordEvidence as record } from '../../support/evidence.js';

/**
 * Gate for tests that call a REAL model endpoint.
 *
 * - Default (`npm test`): SKIPPED unless `AGENT_MODEL_PROVIDER` (and the
 *   endpoint variables) are set. No fake is substituted, so a green default
 *   run never implies real-model behaviour.
 * - AGENT_REQUIRE_REAL_MODEL=1 (`npm run test:model`): the endpoint MUST be
 *   configured or the file FAILS at load with the exact variables to set.
 *
 * The evidence written by these tests contains the safe configuration
 * summary (`apiKeyConfigured: true/false`) — never the key.
 */
const required = process.env['AGENT_REQUIRE_REAL_MODEL'] === '1';

function probe(): { ok: true; config: ModelProviderConfig } | { ok: false; reason: string } {
  let config: ModelProviderConfig;
  try {
    config = resolveModelConfig(process.env);
  } catch (error) {
    const detail = error instanceof ModelProviderError ? error.message : String(error);
    return { ok: false, reason: `model configuration invalid — ${detail}` };
  }
  if (config.kind === 'none') {
    return {
      ok: false,
      reason:
        'AGENT_MODEL_PROVIDER not set (set AGENT_MODEL_PROVIDER=openai-compatible, AGENT_MODEL_BASE_URL, AGENT_MODEL_NAME and, if the endpoint needs one, AGENT_MODEL_API_KEY)',
    };
  }
  return { ok: true, config };
}

const gate = probe();

export const REAL_MODEL_AVAILABLE = gate.ok;
export const MODEL_CONFIG: ModelProviderConfig | undefined = gate.ok ? gate.config : undefined;
export const MODEL_SUMMARY: ModelConfigSummary | undefined = gate.ok
  ? describeModelConfig(gate.config)
  : undefined;
export const SKIP_REASON = gate.ok ? '' : `real-model verification NOT RUN — ${gate.reason}`;

if (!gate.ok) {
  if (required) throw new Error(`${SKIP_REASON}. Refusing to pass without a real model.`);
  console.warn(`[skip] ${SKIP_REASON}`);
}

export const describeRealModel = describe.skipIf(!gate.ok);

/** Real endpoints can be slow, especially free tiers; give them room. */
export function configureRealModelTimeouts(): void {
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
}

export function recordEvidence(name: string, data: unknown): void {
  record(`model-${name}`, {
    model: MODEL_SUMMARY,
    ...(typeof data === 'object' && data ? data : { value: data }),
  });
}
