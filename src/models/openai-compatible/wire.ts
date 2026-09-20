import {
  isRecord,
  parseFail,
  parseOk,
  readOptionalNumber,
  readString,
  type JsonSchema,
  type ParseResult,
} from '../../domain/parse.js';
import type { ToolDescriptor } from '../../tools/contracts.js';
import type {
  FinishReason,
  ModelMessage,
  ModelUsage,
  ProposalAlternative,
  ToolActionProposal,
} from '../contracts.js';
import { ModelProviderError } from '../errors.js';

/**
 * The OpenAI "chat completions" wire format, as implemented by OpenAI,
 * OpenRouter, Groq, Together, Mistral, Ollama, LM Studio, vLLM, llama.cpp and
 * most other hosted or local inference servers. Everything in this file is a
 * pure function over plain data: no I/O, no credentials, no clock. The
 * provider class owns transport; this module owns translation.
 */

// ------------------------------------------------------------------ request

export interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_call_id?: string;
}

export interface WireFunctionTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchema;
  };
}

export type WireResponseFormat =
  | { readonly type: 'json_object' }
  | {
      readonly type: 'json_schema';
      readonly json_schema: { readonly name: string; readonly schema: JsonSchema };
    };

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly WireMessage[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly response_format?: WireResponseFormat;
  readonly tools?: readonly WireFunctionTool[];
  readonly tool_choice?: 'required' | 'auto';
}

/** How structured output is requested. Servers differ in what they support. */
export type StructuredMode = 'json_schema' | 'json_object' | 'prompt';

/** How a tool action is requested: native function calling, or a JSON proposal. */
export type ToolMode = 'tools' | 'json';

export function toWireMessages(messages: readonly ModelMessage[]): WireMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
  }));
}

export interface BaseRequestOptions {
  readonly model: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export function buildTextRequest(
  messages: readonly ModelMessage[],
  options: BaseRequestOptions,
): ChatCompletionRequest {
  return {
    model: options.model,
    messages: toWireMessages(messages),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxOutputTokens !== undefined ? { max_tokens: options.maxOutputTokens } : {}),
  };
}

const JSON_ONLY_INSTRUCTION =
  'Respond with a single JSON object and nothing else: no prose, no markdown fences.';

export function buildStructuredRequest(
  messages: readonly ModelMessage[],
  schema: JsonSchema,
  mode: StructuredMode,
  options: BaseRequestOptions,
): ChatCompletionRequest {
  const base = buildTextRequest(messages, options);
  switch (mode) {
    case 'json_schema':
      return {
        ...base,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'structured_output', schema: withAdditionalProperties(schema) },
        },
      };
    case 'json_object':
      return {
        ...base,
        messages: appendInstruction(
          base.messages,
          `${JSON_ONLY_INSTRUCTION} Schema: ${JSON.stringify(schema)}`,
        ),
        response_format: { type: 'json_object' },
      };
    case 'prompt':
      return {
        ...base,
        messages: appendInstruction(
          base.messages,
          `${JSON_ONLY_INSTRUCTION} Schema: ${JSON.stringify(schema)}`,
        ),
      };
  }
}

/** Strict JSON-schema servers reject objects without an explicit additionalProperties. */
function withAdditionalProperties(schema: JsonSchema): JsonSchema {
  if (schema.type !== 'object' || schema.additionalProperties !== undefined) return schema;
  return { ...schema, additionalProperties: false };
}

function appendInstruction(messages: readonly WireMessage[], instruction: string): WireMessage[] {
  const last = messages.at(-1);
  if (last && last.role === 'user') {
    return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${instruction}` }];
  }
  return [...messages, { role: 'user', content: instruction }];
}

// ------------------------------------------------------- tool-action request

/** Pseudo-tools the model uses to end a task instead of acting. */
export const FINISH_TOOL = 'finish';
export const GIVE_UP_TOOL = 'give_up';

const WIRE_NAME_PATTERN = /[^A-Za-z0-9_-]/g;

/**
 * Function names on the wire are restricted to `[A-Za-z0-9_-]`; our tool
 * names use dots (`fs.write`). The map is bijective within one request and
 * is used to translate the model's choice back.
 */
export class ToolNameMap {
  private readonly toWire = new Map<string, string>();
  private readonly fromWire = new Map<string, string>();

  constructor(names: readonly string[]) {
    for (const name of names) {
      let wire = name.replace(WIRE_NAME_PATTERN, '__');
      let suffix = 1;
      while (this.fromWire.has(wire))
        wire = `${name.replace(WIRE_NAME_PATTERN, '__')}_${(suffix += 1)}`;
      this.toWire.set(name, wire);
      this.fromWire.set(wire, name);
    }
  }

  wireName(name: string): string {
    const wire = this.toWire.get(name);
    if (wire === undefined) throw new Error(`unknown tool name ${name}`);
    return wire;
  }

  originalName(wire: string): string | undefined {
    return this.fromWire.get(wire);
  }
}

const RATIONALE_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  rationale: {
    type: 'string',
    description: 'One or two sentences: why this action makes progress on the current task.',
  },
  confidence: { type: 'number', description: 'Optional, 0..1.' },
  alternatives: {
    type: 'array',
    description: 'Other options you weighed, if any.',
    items: {
      type: 'object',
      properties: { description: { type: 'string' }, whyNot: { type: 'string' } },
      required: ['description', 'whyNot'],
    },
  },
};

/**
 * Each agent tool becomes a function whose parameters wrap the tool's own
 * input schema under `input`, alongside the rationale fields. The wrapper
 * keeps the tool's schema untouched and gives the runtime a validated
 * rationale even from servers that drop assistant text when calling tools.
 */
export function toWireTools(
  tools: readonly ToolDescriptor[],
  names: ToolNameMap,
): WireFunctionTool[] {
  const wrapped = tools.map<WireFunctionTool>((tool) => ({
    type: 'function',
    function: {
      name: names.wireName(tool.name),
      description: `[${tool.family}] ${tool.description}`,
      parameters: {
        type: 'object',
        properties: { input: tool.inputSchema, ...RATIONALE_PROPERTIES },
        required: ['input', 'rationale'],
      },
    },
  }));
  return [
    ...wrapped,
    {
      type: 'function',
      function: {
        name: FINISH_TOOL,
        description:
          'Declare the goal demonstrably complete. The claim will be verified by the evaluator; do not use it to skip work.',
        parameters: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: 'What was achieved and where the evidence is.',
            },
            rationale: RATIONALE_PROPERTIES['rationale']!,
          },
          required: ['summary', 'rationale'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: GIVE_UP_TOOL,
        description: 'Stop because no useful continuation exists with the available tools.',
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          required: ['reason'],
        },
      },
    },
  ];
}

export function buildToolActionRequest(
  messages: readonly ModelMessage[],
  tools: readonly ToolDescriptor[],
  names: ToolNameMap,
  options: BaseRequestOptions,
): ChatCompletionRequest {
  return {
    ...buildTextRequest(messages, options),
    tools: toWireTools(tools, names),
    tool_choice: 'required',
  };
}

/** Schema for the JSON-proposal fallback used with servers that lack function calling. */
export function toolActionProposalSchema(tools: readonly ToolDescriptor[]): JsonSchema {
  return {
    type: 'object',
    description:
      'Exactly one of: {kind:"tool", toolName, input, rationale, confidence?, alternatives?} | {kind:"finish", summary, rationale} | {kind:"give_up", reason}',
    properties: {
      kind: { type: 'string', enum: ['tool', FINISH_TOOL, GIVE_UP_TOOL] },
      toolName: { type: 'string', enum: tools.map((t) => t.name) },
      input: { type: 'object', description: 'Input matching the chosen tool schema' },
      summary: { type: 'string' },
      reason: { type: 'string' },
      ...RATIONALE_PROPERTIES,
    },
    required: ['kind'],
  };
}

export function renderToolsForJsonMode(tools: readonly ToolDescriptor[]): string {
  return [
    'AVAILABLE TOOLS (name, family, description, input schema):',
    ...tools.map(
      (t) =>
        `- ${t.name} (${t.family}): ${t.description}\n  input schema: ${JSON.stringify(t.inputSchema)}`,
    ),
  ].join('\n');
}

// ----------------------------------------------------------------- response

export interface WireToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON text as sent by the server; parsed by the caller. */
  readonly arguments: string;
}

export interface ParsedCompletion {
  readonly content: string | null;
  readonly toolCalls: readonly WireToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: ModelUsage;
  readonly model: string | undefined;
}

/**
 * Validates a chat-completion envelope. A malformed envelope is a `server`
 * error (the transport/proxy is broken); a well-formed envelope whose content
 * is not what we asked for is *not* an error here — content quality is
 * judged by the structured/tool parsers below.
 */
export function parseChatCompletion(body: unknown): ParsedCompletion {
  if (!isRecord(body)) throw envelopeError('response body is not an object');
  if (isRecord(body['error'])) {
    const message =
      typeof body['error']['message'] === 'string' ? body['error']['message'] : 'unknown error';
    throw new ModelProviderError(`provider returned an error envelope: ${message}`, 'server');
  }
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0)
    throw envelopeError('response has no choices');
  const choice = choices[0];
  if (!isRecord(choice) || !isRecord(choice['message']))
    throw envelopeError('choice has no message');
  const message = choice['message'];

  const rawContent = message['content'];
  const content =
    typeof rawContent === 'string'
      ? rawContent
      : Array.isArray(rawContent)
        ? joinContentParts(rawContent)
        : null;

  const toolCalls: WireToolCall[] = [];
  const rawCalls = message['tool_calls'];
  if (Array.isArray(rawCalls)) {
    rawCalls.forEach((call, index) => {
      if (!isRecord(call) || !isRecord(call['function'])) return;
      const fn = call['function'];
      if (typeof fn['name'] !== 'string') return;
      toolCalls.push({
        id: typeof call['id'] === 'string' ? call['id'] : `call_${index}`,
        name: fn['name'],
        arguments:
          typeof fn['arguments'] === 'string'
            ? fn['arguments']
            : JSON.stringify(fn['arguments'] ?? {}),
      });
    });
  }

  return {
    content,
    toolCalls,
    finishReason: toFinishReason(choice['finish_reason'], toolCalls.length > 0),
    usage: toUsage(body['usage']),
    model: typeof body['model'] === 'string' ? body['model'] : undefined,
  };
}

function envelopeError(detail: string): ModelProviderError {
  return new ModelProviderError(`malformed chat completion: ${detail}`, 'server');
}

function joinContentParts(parts: readonly unknown[]): string {
  return parts
    .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : ''))
    .join('');
}

export function toFinishReason(value: unknown, hadToolCalls: boolean): FinishReason {
  switch (value) {
    case 'stop':
    case 'end_turn':
      return hadToolCalls ? 'tool_call' : 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_call';
    case 'content_filter':
      return 'content_filter';
    case null:
    case undefined:
      return hadToolCalls ? 'tool_call' : 'stop';
    default:
      return 'stop';
  }
}

export function toUsage(value: unknown): ModelUsage {
  if (!isRecord(value)) return { inputTokens: 0, outputTokens: 0, reported: false };
  const input = value['prompt_tokens'];
  const output = value['completion_tokens'];
  if (typeof input !== 'number' || typeof output !== 'number') {
    return { inputTokens: 0, outputTokens: 0, reported: false };
  }
  return { inputTokens: input, outputTokens: output };
}

// --------------------------------------------------------- content parsing

/**
 * Best-effort extraction of one JSON value from model text: tolerates
 * markdown fences and leading/trailing prose. Returns `undefined` (never
 * throws) when no JSON value can be found, so the caller can report a
 * parse failure with the raw text attached.
 */
export function extractJson(text: string | null): unknown {
  if (text === null) return undefined;
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== NO_JSON) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const inner = tryParse(fenced[1].trim());
    if (inner !== NO_JSON) return inner;
  }

  const start = trimmed.search(/[[{]/);
  if (start === -1) return undefined;
  const open = trimmed[start];
  const close = open === '{' ? '}' : ']';
  const end = trimmed.lastIndexOf(close);
  if (end <= start) return undefined;
  const sliced = tryParse(trimmed.slice(start, end + 1));
  return sliced === NO_JSON ? undefined : sliced;
}

const NO_JSON: unique symbol = Symbol('no-json');

function tryParse(text: string): unknown | typeof NO_JSON {
  if (text.length === 0) return NO_JSON;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NO_JSON;
  }
}

// ------------------------------------------------------ proposal parsing

function parseAlternatives(raw: unknown, errors: string[]): ProposalAlternative[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push('alternatives must be an array when present');
    return undefined;
  }
  const out: ProposalAlternative[] = [];
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`alternatives[${index}] must be an object`);
      return;
    }
    const local: string[] = [];
    const description = readString(item, 'description', local);
    const whyNot = readString(item, 'whyNot', local);
    errors.push(...local.map((e) => `alternatives[${index}].${e}`));
    out.push({ description, whyNot });
  });
  return out;
}

function parseConfidence(raw: Record<string, unknown>, errors: string[]): number | undefined {
  const confidence = readOptionalNumber(raw, 'confidence', errors);
  if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
    errors.push('confidence must be between 0 and 1');
    return undefined;
  }
  return confidence;
}

/** Arguments of a wrapped tool function → proposal. `toolName` is already translated. */
export function proposalFromToolCall(
  toolName: string,
  args: unknown,
): ParseResult<ToolActionProposal> {
  if (!isRecord(args)) return parseFail('tool call arguments must be an object');
  const errors: string[] = [];
  if (toolName === FINISH_TOOL) {
    const summary = readString(args, 'summary', errors);
    const rationale = readString(args, 'rationale', errors);
    return errors.length > 0
      ? parseFail(...errors)
      : parseOk({ kind: 'finish', summary, rationale });
  }
  if (toolName === GIVE_UP_TOOL) {
    const reason = readString(args, 'reason', errors);
    return errors.length > 0 ? parseFail(...errors) : parseOk({ kind: 'give_up', reason });
  }
  const rationale = readString(args, 'rationale', errors);
  const confidence = parseConfidence(args, errors);
  const alternatives = parseAlternatives(args['alternatives'], errors);
  if (!('input' in args)) errors.push('input is required');
  if (errors.length > 0) return parseFail(...errors);
  return parseOk({
    kind: 'tool',
    toolName,
    input: args['input'],
    rationale,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(alternatives !== undefined ? { alternatives } : {}),
  });
}

/** A JSON proposal (json tool mode, or text fallback) → proposal. */
export function parseToolActionProposal(
  raw: unknown,
  knownToolNames: readonly string[],
): ParseResult<ToolActionProposal> {
  if (!isRecord(raw)) return parseFail('proposal must be an object');
  const errors: string[] = [];
  const kind = readString(raw, 'kind', errors);
  if (errors.length > 0) return parseFail(...errors);
  switch (kind) {
    case FINISH_TOOL:
    case GIVE_UP_TOOL:
      return proposalFromToolCall(kind, raw);
    case 'tool': {
      const toolName = readString(raw, 'toolName', errors);
      if (toolName && !knownToolNames.includes(toolName)) {
        errors.push(`toolName "${toolName}" is not one of: ${knownToolNames.join(', ')}`);
      }
      if (errors.length > 0) return parseFail(...errors);
      return proposalFromToolCall(toolName, raw);
    }
    default:
      return parseFail(`kind must be one of tool, ${FINISH_TOOL}, ${GIVE_UP_TOOL}`);
  }
}

/**
 * Translate a completion into a proposal. Prefers the first tool call; falls
 * back to a JSON proposal in the text (some servers answer that way even when
 * tools are offered). Failure means the model did not answer in either form.
 */
export function proposalFromCompletion(
  completion: ParsedCompletion,
  names: ToolNameMap,
  knownToolNames: readonly string[],
): ParseResult<ToolActionProposal> {
  const call = completion.toolCalls[0];
  if (call) {
    const toolName =
      call.name === FINISH_TOOL || call.name === GIVE_UP_TOOL
        ? call.name
        : names.originalName(call.name);
    if (toolName === undefined) return parseFail(`model called unknown tool "${call.name}"`);
    const args = extractJson(call.arguments);
    if (args === undefined)
      return parseFail(`arguments of tool call "${call.name}" are not valid JSON`);
    return proposalFromToolCall(toolName, args);
  }
  const json = extractJson(completion.content);
  if (json === undefined)
    return parseFail('model returned neither a tool call nor a JSON proposal');
  return parseToolActionProposal(json, knownToolNames);
}
