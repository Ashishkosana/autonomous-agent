import { describe, expect, it } from 'vitest';
import { ModelProviderError } from '../../src/models/errors.js';
import {
  FINISH_TOOL,
  GIVE_UP_TOOL,
  ToolNameMap,
  buildStructuredRequest,
  buildTextRequest,
  buildToolActionRequest,
  extractJson,
  parseChatCompletion,
  parseToolActionProposal,
  proposalFromCompletion,
  toFinishReason,
  toUsage,
  toWireTools,
} from '../../src/models/openai-compatible/wire.js';
import { describeTool } from '../../src/tools/contracts.js';
import { echoTool, writeFileTool } from '../support/tools.js';

const tools = [describeTool(writeFileTool), describeTool(echoTool)];

describe('request building', () => {
  it('maps messages and options onto the chat-completions body', () => {
    const body = buildTextRequest(
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      { model: 'm', temperature: 0.2, maxOutputTokens: 100 },
    );
    expect(body).toEqual({
      model: 'm',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      temperature: 0.2,
      max_tokens: 100,
    });
  });

  it('json_schema mode sends response_format with a closed object schema', () => {
    const body = buildStructuredRequest(
      [{ role: 'user', content: 'plan' }],
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      'json_schema',
      { model: 'm' },
    );
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'structured_output',
        schema: {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
      },
    });
    expect(body.messages).toEqual([{ role: 'user', content: 'plan' }]);
  });

  it('json_object and prompt modes fold the schema into the last user message', () => {
    for (const mode of ['json_object', 'prompt'] as const) {
      const body = buildStructuredRequest(
        [{ role: 'user', content: 'plan' }],
        { type: 'object' },
        mode,
        { model: 'm' },
      );
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.content).toContain('plan');
      expect(body.messages[0]?.content).toContain('single JSON object');
      expect(body.messages[0]?.content).toContain('"type":"object"');
      expect(body.response_format).toEqual(
        mode === 'json_object' ? { type: 'json_object' } : undefined,
      );
    }
  });

  it('translates tool names to the wire alphabet bijectively', () => {
    const names = new ToolNameMap(['fs.write', 'fs__write', 'web.search']);
    expect(names.wireName('fs.write')).toBe('fs__write');
    expect(names.wireName('fs__write')).not.toBe('fs__write');
    expect(names.originalName(names.wireName('fs__write'))).toBe('fs__write');
    expect(names.originalName('fs__write')).toBe('fs.write');
    expect(names.originalName(names.wireName('web.search'))).toBe('web.search');
    expect(names.originalName('nope')).toBeUndefined();
    expect(() => names.wireName('unknown')).toThrow();
  });

  it('wraps each tool schema under `input` with rationale fields and adds finish/give_up', () => {
    const names = new ToolNameMap(tools.map((t) => t.name));
    const wire = toWireTools(tools, names);
    expect(wire.map((t) => t.function.name)).toEqual([
      'fs__write',
      'echo',
      FINISH_TOOL,
      GIVE_UP_TOOL,
    ]);
    const write = wire[0]!.function.parameters;
    expect(write.properties?.['input']).toEqual(describeTool(writeFileTool).inputSchema);
    expect(write.required).toEqual(['input', 'rationale']);
    for (const name of ['fs__write', 'echo', FINISH_TOOL, GIVE_UP_TOOL]) {
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    const body = buildToolActionRequest([{ role: 'user', content: 'act' }], tools, names, {
      model: 'm',
    });
    expect(body.tool_choice).toBe('required');
    expect(body.tools).toHaveLength(4);
  });
});

describe('response parsing', () => {
  it('reads content, tool calls, finish reason and usage from a valid envelope', () => {
    const parsed = parseChatCompletion({
      model: 'served-model',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"input":{}}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    });
    expect(parsed.content).toBeNull();
    expect(parsed.toolCalls).toEqual([{ id: 'c1', name: 'echo', arguments: '{"input":{}}' }]);
    expect(parsed.finishReason).toBe('tool_call');
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(parsed.model).toBe('served-model');
  });

  it('joins content parts and treats non-string arguments defensively', () => {
    const parsed = parseChatCompletion({
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
            tool_calls: [{ function: { name: 'echo', arguments: { input: { message: 'x' } } } }],
          },
          finish_reason: 'stop',
        },
      ],
    });
    expect(parsed.content).toBe('ab');
    expect(parsed.toolCalls[0]).toEqual({
      id: 'call_0',
      name: 'echo',
      arguments: '{"input":{"message":"x"}}',
    });
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 0, reported: false });
  });

  it('rejects malformed envelopes and provider error envelopes as server errors', () => {
    for (const body of [null, 'text', {}, { choices: [] }, { choices: [{}] }]) {
      expect(() => parseChatCompletion(body)).toThrow(ModelProviderError);
      try {
        parseChatCompletion(body);
      } catch (error) {
        expect((error as ModelProviderError).kind).toBe('server');
      }
    }
    expect(() => parseChatCompletion({ error: { message: 'model overloaded' } })).toThrow(
      /model overloaded/,
    );
  });

  it('maps finish reasons across vendor spellings', () => {
    expect(toFinishReason('stop', false)).toBe('stop');
    expect(toFinishReason('stop', true)).toBe('tool_call');
    expect(toFinishReason('end_turn', false)).toBe('stop');
    expect(toFinishReason('length', false)).toBe('length');
    expect(toFinishReason('max_tokens', false)).toBe('length');
    expect(toFinishReason('tool_calls', true)).toBe('tool_call');
    expect(toFinishReason('function_call', true)).toBe('tool_call');
    expect(toFinishReason('content_filter', false)).toBe('content_filter');
    expect(toFinishReason(null, false)).toBe('stop');
    expect(toFinishReason('something-new', false)).toBe('stop');
  });

  it('reports usage honestly: absent or partial usage is zeros with reported=false', () => {
    expect(toUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, reported: false });
    expect(toUsage({ prompt_tokens: 5 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reported: false,
    });
    expect(toUsage({ prompt_tokens: 5, completion_tokens: 2 })).toEqual({
      inputTokens: 5,
      outputTokens: 2,
    });
  });
});

describe('JSON extraction', () => {
  it('parses direct, fenced and prose-wrapped JSON and returns undefined otherwise', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":{"b":[1,2]}} Hope that helps.')).toEqual({
      a: { b: [1, 2] },
    });
    expect(extractJson('[1,2]')).toEqual([1, 2]);
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('{"a":')).toBeUndefined();
    expect(extractJson(null)).toBeUndefined();
    expect(extractJson('')).toBeUndefined();
  });
});

describe('proposal parsing', () => {
  const names = new ToolNameMap(tools.map((t) => t.name));
  const known = tools.map((t) => t.name);

  it('translates a wrapped tool call back into a proposal with the original tool name', () => {
    const result = proposalFromCompletion(
      {
        content: null,
        finishReason: 'tool_call',
        usage: { inputTokens: 0, outputTokens: 0 },
        model: undefined,
        toolCalls: [
          {
            id: 'c1',
            name: 'fs__write',
            arguments: JSON.stringify({
              input: { path: '/workspace/a.md', content: 'x' },
              rationale: 'write the file',
              confidence: 0.8,
              alternatives: [{ description: 'echo', whyNot: 'produces nothing' }],
            }),
          },
        ],
      },
      names,
      known,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'tool',
        toolName: 'fs.write',
        input: { path: '/workspace/a.md', content: 'x' },
        rationale: 'write the file',
        confidence: 0.8,
        alternatives: [{ description: 'echo', whyNot: 'produces nothing' }],
      },
    });
  });

  it('handles finish and give_up pseudo-tools', () => {
    const base = {
      content: null,
      finishReason: 'tool_call' as const,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: undefined,
    };
    expect(
      proposalFromCompletion(
        {
          ...base,
          toolCalls: [
            {
              id: '1',
              name: FINISH_TOOL,
              arguments: '{"summary":"done","rationale":"all evidence present"}',
            },
          ],
        },
        names,
        known,
      ),
    ).toEqual({
      ok: true,
      value: { kind: 'finish', summary: 'done', rationale: 'all evidence present' },
    });
    expect(
      proposalFromCompletion(
        {
          ...base,
          toolCalls: [{ id: '1', name: GIVE_UP_TOOL, arguments: '{"reason":"impossible"}' }],
        },
        names,
        known,
      ),
    ).toEqual({ ok: true, value: { kind: 'give_up', reason: 'impossible' } });
  });

  it('falls back to a JSON proposal in the text and rejects everything else with reasons', () => {
    const base = {
      content: null,
      finishReason: 'stop' as const,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: undefined,
      toolCalls: [],
    };
    expect(
      proposalFromCompletion(
        {
          ...base,
          content: '{"kind":"tool","toolName":"echo","input":{"message":"hi"},"rationale":"r"}',
        },
        names,
        known,
      ),
    ).toEqual({
      ok: true,
      value: { kind: 'tool', toolName: 'echo', input: { message: 'hi' }, rationale: 'r' },
    });

    const prose = proposalFromCompletion({ ...base, content: 'I would use echo.' }, names, known);
    expect(prose.ok).toBe(false);
    if (!prose.ok) expect(prose.errors[0]).toMatch(/neither a tool call nor a JSON proposal/);

    const unknownTool = proposalFromCompletion(
      { ...base, toolCalls: [{ id: '1', name: 'rm_rf', arguments: '{}' }] },
      names,
      known,
    );
    expect(unknownTool.ok).toBe(false);

    const badArgs = proposalFromCompletion(
      { ...base, toolCalls: [{ id: '1', name: 'echo', arguments: '{not json' }] },
      names,
      known,
    );
    expect(badArgs.ok).toBe(false);

    const missingRationale = proposalFromCompletion(
      { ...base, toolCalls: [{ id: '1', name: 'echo', arguments: '{"input":{}}' }] },
      names,
      known,
    );
    expect(missingRationale).toEqual({
      ok: false,
      errors: ['rationale must be a non-empty string'],
    });
  });

  it('validates JSON proposals against the known tool list and value ranges', () => {
    expect(
      parseToolActionProposal({ kind: 'tool', toolName: 'nope', input: {}, rationale: 'r' }, known)
        .ok,
    ).toBe(false);
    expect(parseToolActionProposal({ kind: 'dance' }, known).ok).toBe(false);
    expect(
      parseToolActionProposal(
        { kind: 'tool', toolName: 'echo', input: {}, rationale: 'r', confidence: 3 },
        known,
      ).ok,
    ).toBe(false);
    expect(parseToolActionProposal('nope', known).ok).toBe(false);
    expect(parseToolActionProposal({ kind: 'give_up', reason: 'r' }, known)).toEqual({
      ok: true,
      value: { kind: 'give_up', reason: 'r' },
    });
  });
});
