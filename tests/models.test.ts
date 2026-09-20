import { describe, expect, it } from 'vitest';
import { parseFail, parseOk } from '../src/domain/parse.js';
import type { ModelCallRecord, ToolActionProposal } from '../src/models/contracts.js';
import { describeTool } from '../src/tools/contracts.js';
import { SequentialIdGenerator } from './support/deterministic.js';
import { RUN_ID } from './support/fixtures.js';
import { ScriptedModelProvider } from './support/scripted-model-provider.js';
import { echoTool } from './support/tools.js';

describe('ModelProvider contract', () => {
  it('structured generation returns a ParseResult instead of throwing on bad output', async () => {
    const provider = new ScriptedModelProvider(
      [{ structured: { steps: 'not-an-array' } }, { structured: { steps: ['a', 'b'] } }],
      new SequentialIdGenerator(),
    );
    const request = {
      purpose: 'create_plan' as const,
      messages: [{ role: 'user' as const, content: 'plan it' }],
      schema: { type: 'object' as const, properties: { steps: { type: 'array' as const } } },
      parse: (raw: unknown) => {
        const steps = (raw as { steps?: unknown }).steps;
        return Array.isArray(steps)
          ? parseOk({ steps: steps as string[] })
          : parseFail('steps must be an array');
      },
    };

    const bad = await provider.structuredGenerate(request);
    expect(bad.parsed).toEqual({ ok: false, errors: ['steps must be an array'] });
    expect(bad.raw).toEqual({ steps: 'not-an-array' });

    const good = await provider.structuredGenerate(request);
    expect(good.parsed).toEqual({ ok: true, value: { steps: ['a', 'b'] } });
    expect(good.modelCallId).toBe('mc-2');
  });

  it('tool-action requests receive only tool descriptors, never executable tools', async () => {
    const proposal: ToolActionProposal = {
      kind: 'tool',
      toolName: 'echo',
      input: { message: 'hi' },
      rationale: 'Echo confirms the tool loop works',
    };
    const provider = new ScriptedModelProvider([{ proposal }], new SequentialIdGenerator());

    const response = await provider.requestToolAction({
      purpose: 'select_action',
      messages: [{ role: 'user', content: 'pick a tool' }],
      tools: [describeTool(echoTool)],
    });

    expect(response.proposal).toEqual(proposal);
    const sent = provider.requests[0] as unknown as { tools: unknown[] };
    expect(sent.tools).toHaveLength(1);
    expect(sent.tools[0]).not.toHaveProperty('execute');
  });

  it('every response carries usage and identity needed for a ModelCallRecord', async () => {
    const provider = new ScriptedModelProvider(
      [{ text: 'ok', inputTokens: 120, outputTokens: 30 }],
      new SequentialIdGenerator(),
    );
    const response = await provider.generate({
      purpose: 'summarize',
      messages: [{ role: 'user', content: 'summarize' }],
    });

    const record: ModelCallRecord = {
      modelCallId: response.modelCallId,
      runId: RUN_ID,
      purpose: 'summarize',
      descriptor: response.descriptor,
      usage: response.usage,
      latencyMs: response.latencyMs,
      finishReason: response.finishReason,
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(record.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(record.descriptor).toEqual({ provider: 'scripted', model: 'scripted-v0' });
  });
});
