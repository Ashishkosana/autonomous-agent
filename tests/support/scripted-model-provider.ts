import { asModelCallId, type IdGenerator } from '../../src/domain/ids.js';
import type {
  ModelDescriptor,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StructuredModelRequest,
  StructuredModelResponse,
  ToolActionProposal,
  ToolActionRequest,
  ToolActionResponse,
} from '../../src/models/contracts.js';

interface ScriptedTurn {
  readonly text?: string;
  /** A value, or a function of the request for turns that must echo ids the run generated. */
  readonly structured?: unknown;
  readonly proposal?: ToolActionProposal;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * Returns pre-scripted answers in order. Lets tests drive planner/selector
 * logic without a real model and lets them assert on recorded requests.
 */
export class ScriptedModelProvider implements ModelProvider {
  readonly descriptor: ModelDescriptor = { provider: 'scripted', model: 'scripted-v0' };
  readonly requests: ModelRequest[] = [];
  private readonly turns: ScriptedTurn[];

  constructor(
    turns: readonly ScriptedTurn[],
    private readonly ids: IdGenerator,
  ) {
    this.turns = [...turns];
  }

  private nextTurn(): ScriptedTurn {
    const turn = this.turns.shift();
    if (!turn) throw new Error('ScriptedModelProvider: no scripted turns remain');
    return turn;
  }

  private base(turn: ScriptedTurn) {
    return {
      modelCallId: asModelCallId(this.ids.next('mc')),
      descriptor: this.descriptor,
      usage: { inputTokens: turn.inputTokens ?? 10, outputTokens: turn.outputTokens ?? 5 },
      latencyMs: 1,
      finishReason: 'stop' as const,
    };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const turn = this.nextTurn();
    return { ...this.base(turn), text: turn.text ?? '' };
  }

  async structuredGenerate<T>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResponse<T>> {
    this.requests.push(request);
    const turn = this.nextTurn();
    const structured =
      typeof turn.structured === 'function'
        ? (turn.structured as (request: StructuredModelRequest<T>) => unknown)(request)
        : turn.structured;
    return { ...this.base(turn), raw: structured, parsed: request.parse(structured) };
  }

  async requestToolAction(request: ToolActionRequest): Promise<ToolActionResponse> {
    this.requests.push(request);
    const turn = this.nextTurn();
    if (!turn.proposal) throw new Error('ScriptedModelProvider: turn has no proposal');
    return { ...this.base(turn), proposal: turn.proposal };
  }
}
