import { describe, expect, it } from 'vitest';
import { renderEvent } from '../../src/cli/render.js';
import { runLocalDockerAgent } from '../../src/composition/local-docker-run.js';
import { SubscribableEventSink } from '../../src/events/subscriber.js';
import { LOCAL_SANDBOX_IMAGE } from '../../src/sandbox/local/sandbox-spec.js';
import { ContainerRuntimeError } from '../../src/sandbox/local/container-runtime.js';
import { FakeContainerRuntime } from '../support/fake-container-runtime.js';
import { FixedClock, SequentialIdGenerator } from '../support/deterministic.js';
import { ScriptedModelProvider } from '../support/scripted-model-provider.js';
import {
  APPROACH_B_CONTENT,
  REPORT_PATH,
  REQUIRED_MARKER,
  planTurn,
  writeReport,
} from '../support/runtime-scenario.js';

describe('local Docker composition', () => {
  it('refuses to start when the sandbox image is missing and does not create a container', async () => {
    const runtime = new FakeContainerRuntime();
    const ids = new SequentialIdGenerator();
    await expect(
      runLocalDockerAgent({
        goalStatement: 'do nothing',
        memoryRetrieval: 'on',
        memoryPath: ':memory:',
        model: new ScriptedModelProvider([], ids),
        events: new SubscribableEventSink(),
        runtime,
        ids,
        clock: new FixedClock(),
      }),
    ).rejects.toThrow(/npm run sandbox:build/);
    expect(runtime.containers.size).toBe(0);
  });

  it('refuses host execution when Docker itself is unavailable', async () => {
    const runtime = new FakeContainerRuntime();
    runtime.failWith = new ContainerRuntimeError('daemon is not running', 'engine_unavailable');
    const ids = new SequentialIdGenerator();
    await expect(
      runLocalDockerAgent({
        goalStatement: 'do nothing',
        memoryRetrieval: 'on',
        memoryPath: ':memory:',
        model: new ScriptedModelProvider([], ids),
        events: new SubscribableEventSink(),
        runtime,
        ids,
        clock: new FixedClock(),
      }),
    ).rejects.toThrow(/does not fall back to host execution/);
    expect(runtime.containers.size).toBe(0);
  });

  it('runs the production loop on a fake engine and destroys the container', async () => {
    const runtime = new FakeContainerRuntime();
    runtime.images.add(LOCAL_SANDBOX_IMAGE);
    const ids = new SequentialIdGenerator();
    const events = new SubscribableEventSink();
    const lines: string[] = [];
    events.subscribe((event) => {
      lines.push(...renderEvent(event));
    });
    const outcome = await runLocalDockerAgent({
      goalStatement: `Write ${REPORT_PATH}`,
      verifiableCriteria: [{ kind: 'file_contains', path: REPORT_PATH, marker: REQUIRED_MARKER }],
      memoryRetrieval: 'on',
      memoryPath: ':memory:',
      model: new ScriptedModelProvider(
        [
          planTurn([]),
          {
            proposal: writeReport(APPROACH_B_CONTENT, 'Write the report with the required section'),
          },
        ],
        ids,
      ),
      events,
      runtime,
      ids,
      clock: new FixedClock(),
      resilience: { maxRetries: 0, maxReasks: 0, sleep: async () => {} },
    });

    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.usage.toolCalls).toBe(1);
    expect(outcome.state.usage.modelCalls).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('success — 1/1 decisive checks passed');
    expect(lines.join('\n')).toContain('🔥 COMPLETED');
    expect(lines.join('\n')).toContain('Evaluator: deterministic');
    expect(runtime.containers.size).toBe(0);
  });
});
