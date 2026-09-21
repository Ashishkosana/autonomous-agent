import { asMemoryRecordId, type Clock, type IdGenerator } from '../domain/ids.js';
import type { KnowledgeRecord, SourceReference } from '../memory/records.js';
import type { IngestionInput, IngestionOutput, KnowledgeIngestor } from './contracts.js';

export interface ObservationKnowledgeIngestorOptions {
  /** Characters of content kept per record. Default 2000. */
  readonly maxContentChars?: number;
  /** Content shorter than this (after trimming) is not worth a record. Default 40. */
  readonly minContentChars?: number;
}

/**
 * Rule-based V1 ingestor: content that `web.fetch` or `fs.read` brought back
 * becomes a KnowledgeRecord with the source it came from. It keeps a verbatim
 * excerpt — it does not summarise, judge or "understand" the content, and
 * its confidence values say so:
 *
 *   web.fetch  0.5  something on the web said this (unverified)
 *   fs.read    0.4  a file in the sandbox said this (often the agent's own writing)
 *
 * Recognition is by tool name *and* output shape, so a tool registered under
 * the standard name but returning something else ingests nothing. Failed
 * tool calls and HTTP error pages are never knowledge.
 *
 * Security note: ingested text is untrusted data that later reaches the
 * planner's prompt. Records carry `tags: ['ingested', …]` so a renderer can
 * fence or cap it; nothing here treats it as instructions.
 */
export class ObservationKnowledgeIngestor implements KnowledgeIngestor {
  private readonly maxContentChars: number;
  private readonly minContentChars: number;

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    options: ObservationKnowledgeIngestorOptions = {},
  ) {
    this.maxContentChars = options.maxContentChars ?? 2000;
    this.minContentChars = options.minContentChars ?? 40;
  }

  async ingest(input: IngestionInput): Promise<IngestionOutput> {
    const { observation } = input;
    if (observation.toolResult.status !== 'ok') {
      return { knowledge: [], skipped: 'tool call did not complete' };
    }
    const extracted = extract(observation.toolResult.toolName, observation.toolResult.output);
    if ('skipped' in extracted) return { knowledge: [], skipped: extracted.skipped };

    const text = extracted.text.trim();
    if (text.length < this.minContentChars) {
      return { knowledge: [], skipped: `content too short (${text.length} chars)` };
    }
    const truncated = text.length > this.maxContentChars;
    const content = truncated ? `${text.slice(0, this.maxContentChars)}…` : text;

    const source: SourceReference = {
      ...(extracted.url ? { url: extracted.url } : {}),
      title: extracted.title,
      toolName: observation.toolResult.toolName,
      retrievedAt: observation.observedAt,
      actionId: input.action.actionId,
    };
    const record: KnowledgeRecord = {
      recordId: asMemoryRecordId(this.ids.next('mem')),
      kind: 'knowledge',
      runId: input.correlation.runId,
      goalId: input.correlation.goalId,
      taskId: input.task.taskId,
      createdAt: this.clock.now(),
      summary: `${extracted.title} (${observation.toolResult.toolName}, ${content.length} chars${truncated ? ', truncated' : ''})`,
      tags: ['ingested', observation.toolResult.toolName, ...extracted.tags],
      provenance: {
        actionIds: [input.action.actionId],
        observationIds: [observation.observationId],
        planIds: [input.action.planId],
        ...(input.action.decisionId ? { decisionIds: [input.action.decisionId] } : {}),
      },
      title: extracted.title,
      content,
      sources: [source],
      confidence: extracted.confidence,
    };
    return { knowledge: [record] };
  }
}

interface Extracted {
  readonly title: string;
  readonly text: string;
  readonly url?: string;
  readonly tags: readonly string[];
  readonly confidence: number;
}

function extract(toolName: string, output: unknown): Extracted | { skipped: string } {
  if (!isRecord(output)) return { skipped: 'output is not an object' };
  switch (toolName) {
    case 'web.fetch': {
      const status = output['status'];
      const text = output['text'];
      const url = typeof output['finalUrl'] === 'string' ? output['finalUrl'] : output['url'];
      if (typeof url !== 'string' || typeof text !== 'string' || typeof status !== 'number') {
        return { skipped: 'web.fetch output lacks url/status/text' };
      }
      if (status >= 400) return { skipped: `HTTP ${status} is not knowledge` };
      const title =
        typeof output['title'] === 'string' && output['title'].trim() !== ''
          ? output['title'].trim()
          : url;
      return { title, text, url, tags: [hostOf(url)].filter(Boolean), confidence: 0.5 };
    }
    case 'fs.read': {
      const path = output['path'];
      const content = output['content'];
      if (typeof path !== 'string' || typeof content !== 'string') {
        return { skipped: 'fs.read output lacks path/content' };
      }
      return { title: path, text: content, tags: ['sandbox-file'], confidence: 0.4 };
    }
    default:
      return { skipped: `${toolName} does not return ingestible content` };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
