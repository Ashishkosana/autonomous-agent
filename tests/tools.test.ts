import { describe, expect, it } from 'vitest';
import { ToolRegistry, invokeTool } from '../src/tools/registry.js';
import { ACTION_ID, makeHarness } from './support/fixtures.js';
import { echoTool, explodingTool, writeFileTool } from './support/tools.js';

describe('Tool contract and registry', () => {
  it('describes registered tools for the model without exposing execute()', () => {
    const registry = new ToolRegistry().register(echoTool).register(writeFileTool);
    const descriptors = registry.describeAll();
    expect(descriptors.map((d) => d.name)).toEqual(['echo', 'fs.write']);
    for (const descriptor of descriptors) {
      expect(descriptor).not.toHaveProperty('execute');
      expect(descriptor.inputSchema.type).toBe('object');
    }
  });

  it('rejects duplicate registration', () => {
    const registry = new ToolRegistry().register(echoTool);
    expect(() => registry.register(echoTool)).toThrow(/already registered/);
  });

  it('returns a structured ok result with timing and correlation', async () => {
    const harness = makeHarness();
    const registry = new ToolRegistry().register(echoTool);
    const context = harness.toolContext();
    harness.clock.advance(0);

    const result = await invokeTool(registry, 'echo', { message: 'hi' }, context);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.output).toEqual({ echoed: 'hi' });
    expect(result.toolName).toBe('echo');
    expect(result.actionId).toBe(ACTION_ID);
    expect(result.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.durationMs).toBe(0);
  });

  it('turns unknown tools into a non-retryable structured error instead of throwing', async () => {
    const harness = makeHarness();
    const result = await invokeTool(new ToolRegistry(), 'nope', {}, harness.toolContext());
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.code).toBe('unknown_tool');
    expect(result.error.retryable).toBe(false);
  });

  it('validates model-proposed input before execution', async () => {
    const harness = makeHarness();
    const registry = new ToolRegistry().register(writeFileTool);
    const result = await invokeTool(registry, 'fs.write', { path: 42 }, harness.toolContext());

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.details).toEqual([
      'path must be a non-empty string',
      'content must be a string',
    ]);
    expect(harness.environment.files.size).toBe(0);
  });

  it('converts exceptions thrown by execute() into execution_failed results', async () => {
    const harness = makeHarness();
    const registry = new ToolRegistry().register(explodingTool);
    const result = await invokeTool(registry, 'explode', {}, harness.toolContext());
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.code).toBe('execution_failed');
    expect(result.error.message).toBe('boom');
  });

  it('tools act only through the ExecutionEnvironment in their context', async () => {
    const harness = makeHarness();
    const registry = new ToolRegistry().register(writeFileTool);
    const result = await invokeTool(
      registry,
      'fs.write',
      { path: '/workspace/report.md', content: '# Report' },
      harness.toolContext(),
    );
    expect(result.status).toBe('ok');
    expect(await harness.environment.readFile('/workspace/report.md')).toBe('# Report');
  });
});
