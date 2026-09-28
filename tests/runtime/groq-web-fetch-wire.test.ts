import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseVerifiableCriterion } from '../../src/domain/criteria.js';
import { DeterministicEvaluator } from '../../src/evaluation/deterministic-evaluator.js';
import { OpenAICompatibleProvider } from '../../src/models/openai-compatible/provider.js';
import { createStandardToolRegistry } from '../../src/tools/standard-tools.js';
import { DEMO_CRITERIA, DEMO_GOAL } from '../../spaces/huggingface/app.js';
import { FixedClock, SequentialIdGenerator } from '../support/deterministic.js';
import { FakeExecutionEnvironment } from '../support/fake-execution-environment.js';
import {
  FakeOpenAIServer,
  completion,
  type RecordedRequest,
  type ScriptedReply,
} from '../support/fake-openai-server.js';
import { buildScenario } from '../support/runtime-scenario.js';

/**
 * Groq's gpt-oss models validate the generated function name against
 * `request.tools` and return HTTP 400 during select_action when it does not
 * match. The live failure was a call to `web.__fetch` after we had registered
 * `web__fetch`. This run never sends that name: the mocked server calls
 * `web_fetch`, the exact function name on the wire, and the default
 * example.com goal finishes with a real tool call and a memory write.
 */
const API_KEY = 'sk-groq-wire-0123456789abcdef0123456789abcdef';
const LESSON_PATH = '/workspace/lesson.txt';
const PAGE_URL = 'https://example.com/';

let server: FakeOpenAIServer;
beforeEach(async () => {
  server = await new FakeOpenAIServer().start();
});
afterEach(async () => {
  await server.stop();
});

function examplePageStdout(command: string): string | undefined {
  const match = /__AGENT_HTTP_(act-[0-9a-f]+)__/.exec(command);
  const actionId = match?.[1];
  if (!actionId) return undefined;
  const delimiter = `__AGENT_HTTP_${actionId}__`;
  const html =
    '<!DOCTYPE html><html><head><title>Example Domain</title></head><body><p>Example Domain is a stable public page used to show that a later run can reuse what this fetch stored.</p></body></html>';
  const headers = 'HTTP/1.1 200 OK\ncontent-type: text/html; charset=utf-8\n';
  return (
    `200 0 ${PAGE_URL}` +
    `\n${delimiter} 0\n` +
    headers +
    `\n${delimiter}\n` +
    `${Buffer.byteLength(html)}` +
    `\n${delimiter}\n` +
    html
  );
}

function promptOf(request: RecordedRequest): string {
  const messages = (request.body as { messages?: { content?: string }[] }).messages ?? [];
  return messages.map((message) => message.content ?? '').join('\n');
}

/** Answers the four calls of one successful example.com run, using wire names. */
function groqReplies(): (request: RecordedRequest) => ScriptedReply {
  let fetched = false;
  return (request) => {
    const body = request.body as { tool_choice?: string };
    const prompt = promptOf(request);
    if (body.tool_choice === 'required') {
      if (!fetched) {
        fetched = true;
        return {
          kind: 'json',
          body: completion({
            model: 'openai/gpt-oss-120b',
            toolCalls: [
              {
                name: 'web_fetch',
                arguments: {
                  input: { url: PAGE_URL },
                  rationale: 'Read the public example.com page',
                },
              },
            ],
          }),
        };
      }
      return {
        kind: 'json',
        body: completion({
          model: 'openai/gpt-oss-120b',
          toolCalls: [
            {
              name: 'fs_write',
              arguments: {
                input: {
                  path: LESSON_PATH,
                  content: 'Example Domain\nThe page title is worth storing for the next run.\n',
                },
                rationale: 'Write the lesson file the goal asks for',
              },
            },
          ],
        }),
      };
    }
    if (prompt.includes('current approach inadequate')) {
      const taskId = /- \[([^\]]+)\] \(in_progress\)/.exec(prompt)?.[1];
      if (!taskId) throw new Error('revision prompt has no in-progress task');
      return {
        kind: 'json',
        body: completion({
          model: 'openai/gpt-oss-120b',
          content: JSON.stringify({
            strategySummary: 'Write the lesson file from the page that was just fetched',
            strategyChanged: false,
            revisionReason: 'The page is fetched and the lesson file is not written yet',
            tasks: [
              {
                taskId,
                description: 'Write /workspace/lesson.txt with the page title',
                expectedEvidence: ['/workspace/lesson.txt contains Example Domain'],
              },
            ],
            citedMemoryRecordIds: [],
          }),
        }),
      };
    }
    return {
      kind: 'json',
      body: completion({
        model: 'openai/gpt-oss-120b',
        content: JSON.stringify({
          strategySummary: 'Read example.com and write the lesson file',
          tasks: [
            {
              description: 'Read https://example.com and write /workspace/lesson.txt',
              expectedEvidence: ['/workspace/lesson.txt contains Example Domain'],
            },
          ],
          citedMemoryRecordIds: [],
        }),
      }),
    };
  };
}

describe('Groq tool names on the default example.com goal', () => {
  it('completes when the model calls the registered web_fetch name', async () => {
    const criterion = parseVerifiableCriterion(DEMO_CRITERIA);
    expect(criterion).toEqual({
      kind: 'file_contains',
      path: LESSON_PATH,
      marker: 'Example Domain',
    });
    const environment = new FakeExecutionEnvironment();
    environment.setCommandScript((command) => ({
      command,
      exitCode: 0,
      stdout: examplePageStdout(command) ?? '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
    }));
    server.respondWith(groqReplies());

    const ids = new SequentialIdGenerator();
    const scenario = await buildScenario({
      turns: [],
      seed: [],
      goalStatement: DEMO_GOAL,
      verifiableCriteria: [criterion!],
      memory: 'on',
      environment,
      tools: createStandardToolRegistry(),
      evaluator: (evalIds, clock) => new DeterministicEvaluator(evalIds, clock),
      ids,
      model: new OpenAICompatibleProvider(
        {
          baseUrl: server.baseUrl,
          model: 'openai/gpt-oss-120b',
          apiKey: API_KEY,
          providerLabel: 'groq',
          timeoutMs: 2_000,
        },
        { clock: new FixedClock(), ids },
      ),
    });

    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.usage.toolCalls).toBeGreaterThanOrEqual(1);
    expect(outcome.state.usage.memoryWrites).toBeGreaterThanOrEqual(1);
    expect(scenario.events.ofType('TOOL_COMPLETED').map((event) => event.payload.toolName)).toEqual(
      ['web.fetch', 'fs.write'],
    );
    expect(scenario.events.ofType('KNOWLEDGE_INGESTED').length).toBeGreaterThanOrEqual(1);
    expect(scenario.events.ofType('MEMORY_WRITTEN').length).toBeGreaterThanOrEqual(1);
    const knowledge = await scenario.store.query({ kinds: ['knowledge'] });
    expect(knowledge.length).toBeGreaterThanOrEqual(1);
    expect(await environment.readFile(LESSON_PATH)).toContain('Example Domain');

    const toolRequests = server.requests.filter(
      (request) => (request.body as { tool_choice?: string }).tool_choice === 'required',
    );
    expect(toolRequests.length).toBeGreaterThanOrEqual(1);
    for (const request of toolRequests) {
      const names = (request.body as { tools: { function: { name: string } }[] }).tools.map(
        (tool) => tool.function.name,
      );
      expect(names).toContain('web_fetch');
      expect(names).not.toContain('web.fetch');
      expect(names).not.toContain('web__fetch');
      expect(names).not.toContain('web.__fetch');
      for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
    expect(server.requests.some((request) => request.rawBody.includes('web.__fetch'))).toBe(false);
    expect(server.requests.some((request) => request.rawBody.includes('web__fetch'))).toBe(false);
  });
});
