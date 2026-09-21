import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local HTTP server that speaks the OpenAI chat-completions wire format.
 * Tests script its replies per request; it records every request (headers,
 * URL, parsed body) so tests can assert exactly what the adapter sent — and
 * exactly what it did not send.
 */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly rawBody: string;
}

export type ScriptedReply =
  | {
      readonly kind: 'json';
      readonly status?: number;
      readonly body: unknown;
      readonly headers?: Record<string, string>;
    }
  | {
      readonly kind: 'text';
      readonly status: number;
      readonly body: string;
      readonly headers?: Record<string, string>;
    }
  | { readonly kind: 'hang'; readonly ms: number }
  | { readonly kind: 'close' };

export interface CompletionOptions {
  readonly content?: string | null;
  readonly toolCalls?: readonly { name: string; arguments: unknown; id?: string }[];
  readonly finishReason?: string | null;
  readonly usage?: { prompt_tokens: number; completion_tokens: number } | null;
  readonly model?: string;
}

/** Builds a well-formed completion envelope. */
export function completion(options: CompletionOptions = {}): unknown {
  const toolCalls = options.toolCalls?.map((call, index) => ({
    id: call.id ?? `call_${index + 1}`,
    type: 'function',
    function: {
      name: call.name,
      arguments:
        typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
    },
  }));
  const usage =
    options.usage === null
      ? {}
      : { usage: options.usage ?? { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } };
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: options.model ?? 'test-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: options.content === undefined ? null : options.content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason:
          options.finishReason === undefined
            ? toolCalls
              ? 'tool_calls'
              : 'stop'
            : options.finishReason,
      },
    ],
    ...usage,
  };
}

/** Builds a well-formed `/embeddings` envelope; `indices` lets a test scramble the order. */
export function embeddingsEnvelope(
  vectors: readonly (readonly number[])[],
  options: { readonly indices?: readonly number[]; readonly promptTokens?: number | null } = {},
): unknown {
  return {
    object: 'list',
    data: vectors.map((embedding, i) => ({
      object: 'embedding',
      index: options.indices?.[i] ?? i,
      embedding,
    })),
    model: 'test-embedding-model',
    ...(options.promptTokens === null
      ? {}
      : {
          usage: {
            prompt_tokens: options.promptTokens ?? 12,
            total_tokens: options.promptTokens ?? 12,
          },
        }),
  };
}

export class FakeOpenAIServer {
  readonly requests: RecordedRequest[] = [];
  private readonly replies: ScriptedReply[] = [];
  private responder: ((request: RecordedRequest) => ScriptedReply) | undefined;
  private server: Server | undefined;
  private port = 0;

  /** Queue replies consumed in order. */
  enqueue(...replies: ScriptedReply[]): this {
    this.replies.push(...replies);
    return this;
  }

  /** Or compute the reply from the request (used by the runtime scenario). */
  respondWith(responder: (request: RecordedRequest) => ScriptedReply): this {
    this.responder = responder;
    return this;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }
    const recorded: RecordedRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers,
      body,
      rawBody,
    };
    this.requests.push(recorded);

    const reply: ScriptedReply = this.replies.shift() ??
      this.responder?.(recorded) ?? {
        kind: 'json',
        status: 500,
        body: { error: { message: 'fake server: no scripted reply' } },
      };

    switch (reply.kind) {
      case 'json':
        res.writeHead(reply.status ?? 200, {
          'content-type': 'application/json',
          ...reply.headers,
        });
        res.end(JSON.stringify(reply.body));
        return;
      case 'text':
        res.writeHead(reply.status, { 'content-type': 'text/plain', ...reply.headers });
        res.end(reply.body);
        return;
      case 'hang':
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(completion({ content: 'too late' })));
          }
        }, reply.ms).unref();
        return;
      case 'close':
        res.destroy();
        return;
    }
  }
}
