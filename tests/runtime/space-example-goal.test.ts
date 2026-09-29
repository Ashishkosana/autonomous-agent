import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSpaceAgent } from '../../src/composition/space-run.js';
import { parseVerifiableCriterion } from '../../src/domain/criteria.js';
import type { StructuredModelRequest } from '../../src/models/contracts.js';
import { OpenAICompatibleProvider } from '../../src/models/openai-compatible/provider.js';
import { openMemoryStore } from '../../src/memory/config.js';
import type { OpenedMemory } from '../../src/memory/opened-memory.js';
import { SpaceProcessEnvironment } from '../../src/sandbox/space/space-process-environment.js';
import { DEMO_CRITERIA, DEMO_GOAL } from '../../spaces/huggingface/app.js';
import { FixedClock, SequentialIdGenerator } from '../support/deterministic.js';
import { FakeOpenAIServer, completion } from '../support/fake-openai-server.js';
import { InMemoryEventBus } from '../support/in-memory-event-bus.js';
import { ScriptedModelProvider } from '../support/scripted-model-provider.js';

/**
 * The Railway/Space runner stores files under `/tmp/agent-space-*` and the
 * default goal writes `/workspace/lesson.txt`. This run uses the real
 * SpaceProcessEnvironment: `web.fetch` (curl scratch under `/workspace`) and
 * `fs.write` of that goal path must both land in the ephemeral directory,
 * and the file criterion must pass.
 */
const linux = platform() === 'linux';
const LESSON = '/workspace/lesson.txt';
const PAGE_HTML = `<!DOCTYPE html><html><head><title>Example Domain</title></head>
<body><p>Example Domain is a stable public page used so a later run can reuse what this fetch stored in durable memory.</p></body></html>`;

describe.skipIf(!linux)('default example.com goal on SpaceProcessEnvironment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-space-goal-'));
  const root = mkdtempSync(join(tmpdir(), 'agent-space-root-'));
  let page: Server;
  let pageUrl = '';
  let memory: OpenedMemory;
  let environment: SpaceProcessEnvironment;

  beforeAll(async () => {
    page = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE_HTML);
    });
    await new Promise<void>((resolve) => page.listen(0, '127.0.0.1', resolve));
    const address = page.address() as AddressInfo;
    pageUrl = `http://127.0.0.1:${address.port}/`;
    memory = await openMemoryStore({ kind: 'sqlite', path: join(dir, 'memory.sqlite') });
    environment = await SpaceProcessEnvironment.start({
      workspaceRoot: root,
      environmentId: 'space-goal',
      ephemeral: true,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => page.close(() => resolve()));
    await environment.destroy().catch(() => undefined);
    await memory.close();
  });

  it('fetches a page, writes /workspace/lesson.txt, and stores knowledge and a lesson', async () => {
    const criterion = parseVerifiableCriterion(DEMO_CRITERIA);
    expect(criterion).toEqual({
      kind: 'file_contains',
      path: LESSON,
      marker: 'Example Domain',
    });
    const ids = new SequentialIdGenerator();
    const events = new InMemoryEventBus();
    const outcome = await runSpaceAgent({
      goalStatement: DEMO_GOAL,
      verifiableCriteria: [criterion!],
      memoryRetrieval: 'on',
      memory,
      model: new ScriptedModelProvider(
        [
          {
            structured: {
              strategySummary: 'Read the page and write the lesson file',
              tasks: [
                {
                  description: 'Read the public page and write /workspace/lesson.txt',
                  expectedEvidence: ['/workspace/lesson.txt contains Example Domain'],
                },
              ],
              citedMemoryRecordIds: [],
            },
          },
          {
            proposal: {
              kind: 'tool',
              toolName: 'web.fetch',
              input: { url: pageUrl },
              rationale: 'Read the public page before writing the lesson',
            },
          },
          {
            structured: (request: StructuredModelRequest<unknown>) => {
              const prompt = request.messages.map((message) => message.content).join('\n');
              const taskId = /- \[([^\]]+)\] \(in_progress\)/.exec(prompt)?.[1];
              if (!taskId) throw new Error('revision prompt has no in-progress task');
              return {
                strategySummary: 'Write the lesson file from the fetched page',
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
              };
            },
          },
          {
            proposal: {
              kind: 'tool',
              toolName: 'fs.write',
              input: {
                path: LESSON,
                content:
                  'Example Domain\nThe page title is worth storing for the next run of this goal.\n',
              },
              rationale: 'Write the lesson file the goal asks for',
            },
          },
        ],
        ids,
      ),
      events,
      environment,
      limits: {
        maxIterations: 8,
        maxToolCalls: 12,
        maxModelCalls: 24,
        maxTotalTokens: 100_000,
        maxDurationMs: 60_000,
      },
      clock: new FixedClock(),
      ids,
      resilience: { maxRetries: 0, maxReasks: 0, sleep: async () => {} },
    });

    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.usage.toolCalls).toBeGreaterThanOrEqual(1);
    expect(outcome.state.usage.memoryWrites).toBeGreaterThanOrEqual(1);
    expect(events.ofType('TOOL_COMPLETED').map((event) => event.payload.toolName)).toEqual([
      'web.fetch',
      'fs.write',
    ]);
    expect(events.ofType('KNOWLEDGE_INGESTED').length).toBeGreaterThanOrEqual(1);
    expect(events.ofType('LESSON_CREATED').length).toBeGreaterThanOrEqual(1);
    const knowledge = await memory.store.query({ kinds: ['knowledge'] });
    const lessons = await memory.store.query({ kinds: ['lesson'] });
    expect(knowledge.length).toBeGreaterThanOrEqual(1);
    expect(lessons.length).toBeGreaterThanOrEqual(1);
    expect(await environment.readFile(LESSON)).toContain('Example Domain');
    expect(await environment.readFile(`${root}/lesson.txt`)).toContain('Example Domain');
    expect(existsSync(LESSON)).toBe(false);
    expect(existsSync('/workspace/.agent/http')).toBe(false);
  });

  it('completes when Groq omits the input wrapper and is shown the page before writing', async () => {
    const criterion = parseVerifiableCriterion(DEMO_CRITERIA);
    expect(criterion).toBeDefined();
    if (await environment.fileExists(LESSON)) await environment.deleteFile(LESSON);
    const server = await new FakeOpenAIServer().start();
    const ids = new SequentialIdGenerator();
    const events = new InMemoryEventBus();
    server.respondWith((request) => {
      const body = request.body as { tool_choice?: string; messages?: { content?: string }[] };
      const prompt = (body.messages ?? []).map((message) => message.content ?? '').join('\n');
      if (body.tool_choice === 'required') {
        if (!prompt.includes('NEXT ACTION')) {
          return {
            kind: 'json',
            body: completion({
              toolCalls: [
                {
                  name: 'web_fetch',
                  arguments: { url: pageUrl },
                },
              ],
            }),
          };
        }
        return {
          kind: 'json',
          body: completion({
            toolCalls: [
              {
                name: 'fs_write',
                arguments: {
                  path: LESSON,
                  content:
                    'Example Domain\nThe page title is worth storing for the next run of this goal.\n',
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
            content: JSON.stringify({
              strategySummary: 'Write the lesson file from the page that was fetched',
              strategyChanged: false,
              revisionReason: 'The page text is known and the lesson file is not written yet',
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
          content: JSON.stringify({
            strategySummary: 'Fetch the page once, then write the lesson file',
            tasks: [
              {
                description: 'Fetch the page once',
                expectedEvidence: ['web.fetch returned the page text'],
              },
              {
                description: 'Write /workspace/lesson.txt with the page title',
                expectedEvidence: ['/workspace/lesson.txt contains Example Domain'],
              },
            ],
            citedMemoryRecordIds: [],
          }),
        }),
      };
    });

    try {
      const outcome = await runSpaceAgent({
        goalStatement: DEMO_GOAL,
        verifiableCriteria: [criterion!],
        memoryRetrieval: 'on',
        memory,
        model: new OpenAICompatibleProvider(
          {
            baseUrl: server.baseUrl,
            model: 'openai/gpt-oss-120b',
            apiKey: 'sk-space-flat-args-test',
            providerLabel: 'groq',
            timeoutMs: 2_000,
          },
          { clock: new FixedClock(), ids },
        ),
        events,
        environment,
        limits: {
          maxIterations: 8,
          maxToolCalls: 12,
          maxModelCalls: 32,
          maxTotalTokens: 100_000,
          maxDurationMs: 60_000,
        },
        clock: new FixedClock(),
        ids,
        resilience: { maxRetries: 0, maxReasks: 0, sleep: async () => {} },
      });

      expect(outcome.state.status).toBe('completed');
      expect(events.ofType('TOOL_COMPLETED').map((event) => event.payload.toolName)).toContain(
        'fs.write',
      );
      expect(events.ofType('KNOWLEDGE_INGESTED').length).toBeGreaterThanOrEqual(1);
      expect(await environment.readFile(LESSON)).toContain('Example Domain');
      expect(await environment.readFile(`${root}/lesson.txt`)).toContain('Example Domain');

      const toolRequests = server.requests.filter(
        (request) => (request.body as { tool_choice?: string }).tool_choice === 'required',
      );
      expect(toolRequests.length).toBeGreaterThanOrEqual(2);
      const parameters = (
        toolRequests[0]!.body as {
          tools: { function: { name: string; parameters: { required?: string[] } } }[];
        }
      ).tools.find((tool) => tool.function.name === 'web_fetch')?.function.parameters;
      expect(parameters?.required).toEqual(['url']);
      expect(parameters?.required).not.toContain('input');
      const writePrompt = JSON.stringify(toolRequests[1]!.body);
      expect(writePrompt).toContain('stable public page');
      expect(writePrompt).toContain('Do not call web.fetch again');
      expect(writePrompt).toContain('fs.write');
      const revisePrompt = server.requests
        .map((request) => JSON.stringify(request.body))
        .find((body) => body.includes('current approach inadequate'));
      expect(revisePrompt).toContain('stable public page');
    } finally {
      await server.stop();
    }
  });
});
