import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolActionProposal } from '../../src/models/contracts.js';
import { OpenAICompatibleProvider } from '../../src/models/openai-compatible/provider.js';
import { FixedClock, SequentialIdGenerator } from '../support/deterministic.js';
import type { FakeExecutionEnvironment } from '../support/fake-execution-environment.js';
import { FakeOpenAIServer, completion, type ScriptedReply } from '../support/fake-openai-server.js';
import {
  APPROACH_A_CONTENT,
  APPROACH_B_CONTENT,
  REPORT_PATH,
  SEED_KNOWLEDGE_ID,
  buildScenario,
  planTurn,
  reviseTurn,
  writeReport,
  type ScenarioTurn,
} from '../support/runtime-scenario.js';

/**
 * E-000 replayed through the real OpenAI-compatible adapter and a real local
 * HTTP server instead of the in-process scripted provider. The model's
 * answers are the same as in `autonomous-loop.test.ts`; what is new is that
 * they now travel as chat-completion JSON, tool calls and response_format
 * requests over HTTP — proving the runtime is agnostic to which provider
 * implementation sits behind `ModelProvider`, and that the wire adapter's
 * recovery paths compose with the loop.
 */
const API_KEY = 'sk-e000-0123456789abcdef0123456789abcdef';

let server: FakeOpenAIServer;
beforeEach(async () => {
  server = await new FakeOpenAIServer().start();
});
afterEach(async () => {
  await server.stop();
});

/** Translate a scripted turn into what an OpenAI-compatible server would answer. */
function reply(turn: ScenarioTurn): ScriptedReply {
  const usage = {
    prompt_tokens: turn.inputTokens ?? 100,
    completion_tokens: turn.outputTokens ?? 20,
  };
  if (turn.structured !== undefined) {
    return { kind: 'json', body: completion({ content: JSON.stringify(turn.structured), usage }) };
  }
  if (turn.proposal)
    return { kind: 'json', body: completion({ toolCalls: [toolCall(turn.proposal)], usage }) };
  return { kind: 'json', body: completion({ content: turn.text ?? '', usage }) };
}

function toolCall(proposal: ToolActionProposal) {
  switch (proposal.kind) {
    case 'tool':
      return {
        name: proposal.toolName.replace(/[^A-Za-z0-9_-]/g, '__'),
        arguments: {
          input: proposal.input,
          rationale: proposal.rationale,
          ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
        },
      };
    case 'finish':
      return {
        name: 'finish',
        arguments: { summary: proposal.summary, rationale: proposal.rationale },
      };
    case 'give_up':
      return { name: 'give_up', arguments: { reason: proposal.reason } };
  }
}

const E000_TURNS: ScenarioTurn[] = [
  planTurn([SEED_KNOWLEDGE_ID]),
  { proposal: writeReport(APPROACH_A_CONTENT, 'Write the report body directly') },
  reviseTurn({ strategyChanged: true }),
  {
    proposal: writeReport(
      APPROACH_B_CONTENT,
      'Rewrite with the Sources section the evaluator requires',
    ),
  },
];

async function scenarioOverHttp(replies: ScriptedReply[], resilience = {}) {
  server.enqueue(...replies);
  const model = new OpenAICompatibleProvider(
    {
      baseUrl: server.baseUrl,
      model: 'fake/e000-model',
      apiKey: API_KEY,
      providerLabel: 'fake-http',
      timeoutMs: 2_000,
    },
    { clock: new FixedClock(), ids: new SequentialIdGenerator() },
  );
  return buildScenario({ turns: [], model, resilience });
}

describe('E-000 through the OpenAI-compatible adapter over HTTP', () => {
  it('completes the goal with the same recovery story as the in-process scripted run', async () => {
    const scenario = await scenarioOverHttp(E000_TURNS.map(reply));
    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.usage.iterations).toBe(2);
    expect(outcome.state.usage.retries).toBe(1);
    expect(outcome.state.usage.strategyChanges).toBe(1);
    expect(outcome.state.usage.modelCalls).toBe(4);
    expect(outcome.state.usage.inputTokens).toBe(400);
    expect(outcome.state.usage.outputTokens).toBe(80);
    expect(await (scenario.environment as FakeExecutionEnvironment).readFile(REPORT_PATH)).toBe(
      APPROACH_B_CONTENT,
    );
    expect(scenario.events.ofType('STRATEGY_CHANGED')).toHaveLength(1);
    expect(scenario.events.ofType('LESSON_CREATED')).toHaveLength(1);
  });

  it('sends each purpose in the right wire shape with the key only in the Authorization header', async () => {
    const scenario = await scenarioOverHttp(E000_TURNS.map(reply));
    await scenario.run();

    const bodies = server.requests.map((r) => r.body as Record<string, unknown>);
    expect(server.requests).toHaveLength(4);
    expect(
      bodies.map((b) => (b['response_format'] as { type?: string } | undefined)?.type),
    ).toEqual(['json_schema', undefined, 'json_schema', undefined]);
    expect(bodies.map((b) => b['tool_choice'])).toEqual([
      undefined,
      'required',
      undefined,
      'required',
    ]);
    for (const request of server.requests) {
      expect(request.headers['authorization']).toBe(`Bearer ${API_KEY}`);
      expect(request.rawBody).not.toContain(API_KEY);
      expect(request.url).not.toContain(API_KEY);
    }
    // The prompt that reached the server carries the retrieved memory, proving retrieval feeds the real request path.
    const planPrompt = JSON.stringify(bodies[0]!['messages']);
    expect(planPrompt).toContain('Sources section');
    expect(planPrompt).toContain(SEED_KNOWLEDGE_ID);
  });

  it('emits paired MODEL_CALL_STARTED / MODEL_CALL_COMPLETED events with real usage and the provider label', async () => {
    const scenario = await scenarioOverHttp(E000_TURNS.map(reply));
    await scenario.run();

    const started = scenario.events.ofType('MODEL_CALL_STARTED');
    const completed = scenario.events.ofType('MODEL_CALL_COMPLETED');
    expect(started).toHaveLength(4);
    expect(completed).toHaveLength(4);
    expect(scenario.events.ofType('MODEL_CALL_FAILED')).toHaveLength(0);
    expect(started.map((e) => e.payload.modelCallId)).toEqual(
      completed.map((e) => e.payload.modelCallId),
    );
    expect(new Set(started.map((e) => e.payload.modelCallId)).size).toBe(4);
    expect(started.map((e) => e.payload.purpose)).toEqual([
      'create_plan',
      'select_action',
      'revise_plan',
      'select_action',
    ]);
    for (const event of completed) {
      expect(event.payload).toMatchObject({
        provider: 'fake-http',
        model: 'fake/e000-model',
        inputTokens: 100,
        outputTokens: 20,
        usageReported: true,
        attempt: 1,
      });
      expect(event.correlation.modelCallId).toBe(event.payload.modelCallId);
    }
    expect(completed.map((e) => e.payload.finishReason)).toEqual([
      'stop',
      'tool_call',
      'stop',
      'tool_call',
    ]);
    // Started strictly before its completion, for every call.
    started.forEach((s, i) => expect(s.sequence).toBeLessThan(completed[i]!.sequence));
  });

  it('keeps the credential out of events, memory and the sandbox', async () => {
    const scenario = await scenarioOverHttp(E000_TURNS.map(reply));
    await scenario.run();

    expect(JSON.stringify(scenario.events.events)).not.toContain(API_KEY);
    expect(JSON.stringify(await scenario.store.query({}))).not.toContain(API_KEY);
    expect(
      await (scenario.environment as FakeExecutionEnvironment).readFile(REPORT_PATH),
    ).not.toContain(API_KEY);
    // Nor prompts or completions: events carry telemetry, not content.
    expect(JSON.stringify(scenario.events.ofType('MODEL_CALL_COMPLETED'))).not.toContain(
      'Sources section',
    );
  });

  it('recovers from a malformed plan by re-asking once, visibly, and still completes', async () => {
    const replies = [
      {
        kind: 'json',
        body: completion({ content: 'Sure! First I would gather sources, then write.' }),
      } as ScriptedReply,
      ...E000_TURNS.map(reply),
    ];
    const scenario = await scenarioOverHttp(replies, { maxReasks: 1 });
    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.usage.modelCalls).toBe(5);
    const completed = scenario.events.ofType('MODEL_CALL_COMPLETED');
    expect(completed.map((e) => e.payload.attempt)).toEqual([1, 2, 1, 1, 1]);
    expect(completed[0]?.payload.purpose).toBe('create_plan');
    // The correction turn went over the wire.
    const second = server.requests[1]!.body as { messages: { role: string; content: string }[] };
    expect(second.messages.at(-1)?.content).toContain('rejected by validation');
    expect(second.messages.at(-2)?.content).toBe('Sure! First I would gather sources, then write.');
    expect(scenario.events.ofType('PLAN_CREATED')).toHaveLength(1);
  });

  it('retries a transient 503 with a MODEL_CALL_FAILED event in between, and still completes', async () => {
    const replies = [
      { kind: 'text', status: 503, body: 'overloaded' } as ScriptedReply,
      ...E000_TURNS.map(reply),
    ];
    const scenario = await scenarioOverHttp(replies, { maxRetries: 1 });
    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.usage.modelCalls).toBe(5);
    const failed = scenario.events.ofType('MODEL_CALL_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({
      purpose: 'create_plan',
      errorKind: 'server',
      retryable: true,
      attempt: 1,
      provider: 'fake-http',
    });
    expect(failed[0]?.payload.message).toContain('HTTP 503');
    const started = scenario.events.ofType('MODEL_CALL_STARTED');
    expect(started.map((e) => e.payload.attempt)).toEqual([1, 2, 1, 1, 1]);
    expect(failed[0]!.sequence).toBeGreaterThan(started[0]!.sequence);
    expect(failed[0]!.sequence).toBeLessThan(started[1]!.sequence);
  });

  it('an exhausted re-ask budget ends the run as a controlled failure, not a crash, with a redacted reason', async () => {
    const replies = [
      reply(planTurn([SEED_KNOWLEDGE_ID])),
      {
        kind: 'json',
        body: completion({ content: `I think ${API_KEY} lets me write files.` }),
      } as ScriptedReply,
      { kind: 'json', body: completion({ content: 'Still thinking.' }) } as ScriptedReply,
    ];
    const scenario = await scenarioOverHttp(replies, { maxReasks: 1 });
    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('failed');
    const failed = scenario.events.ofType('GOAL_FAILED');
    expect(failed[0]?.payload.cause).toBe('unrecoverable');
    expect(failed[0]?.payload.reason).toContain('valid tool action');
    expect(JSON.stringify(scenario.events.events)).not.toContain(API_KEY);
    expect(scenario.events.ofType('MODEL_CALL_STARTED')).toHaveLength(3);
    expect(scenario.events.ofType('MODEL_CALL_FAILED').map((e) => e.payload.errorKind)).toEqual([
      'invalid_response',
      'invalid_response',
    ]);
    expect(scenario.events.ofType('TOOL_STARTED')).toHaveLength(0);
  });

  it('an authentication failure is not retried and ends the run with a redacted reason', async () => {
    const replies = [
      {
        kind: 'json',
        status: 401,
        body: { error: { message: `bad key ${API_KEY}` } },
      } as ScriptedReply,
      reply(planTurn()),
    ];
    const scenario = await scenarioOverHttp(replies, { maxRetries: 2, maxReasks: 1 });
    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('failed');
    expect(server.requests).toHaveLength(1);
    const failed = scenario.events.ofType('MODEL_CALL_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ errorKind: 'authentication', retryable: false });
    expect(JSON.stringify(scenario.events.events)).not.toContain(API_KEY);
    expect(JSON.stringify(scenario.events.events)).toContain('[REDACTED]');
  });
});
