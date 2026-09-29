import { asMemoryRecordId, type ActionId, type Clock, type IdGenerator } from '../domain/ids.js';
import type { KnowledgeRecord, SourceReference } from '../memory/records.js';
import { htmlToText } from '../tools/web/html-to-text.js';
import type { IngestionInput, IngestionOutput, KnowledgeIngestor } from './contracts.js';

export interface ObservationKnowledgeIngestorOptions {
  /** Characters of content kept per record. Default 2000. */
  readonly maxContentChars?: number;
  /** Content shorter than this (after trimming) is not worth a record. Default 40. */
  readonly minContentChars?: number;
}

/**
 * Rule-based V1 ingestor: content that `web.fetch`, a document-like
 * `http.request`, or `fs.read` brought back becomes a KnowledgeRecord with
 * the source it came from. It keeps a verbatim excerpt — it does not
 * summarise, judge or "understand" the content, and its confidence values
 * say so:
 *
 *   web.fetch      0.5  something on the web said this (unverified)
 *   http.request   0.5  same, when the response is a public document
 *   fs.read        0.4  a file in the sandbox said this (often the agent's own writing)
 *
 * `http.request` is a general HTTP tool. Only a successful GET (the tool
 * default) whose body is document-like text/html, xhtml, or plain text
 * becomes knowledge. JSON, scripts, binary, and other media types do not.
 * HTML is reduced with the same `htmlToText` `web.fetch` uses, so the
 * excerpt is the page the agent read, not the markup.
 *
 * Recognition is by tool name *and* output shape, so a tool registered under
 * the standard name but returning something else ingests nothing. Failed
 * tool calls and HTTP error pages are never knowledge.
 *
 * One action that reads the same URL with both `web.fetch` and
 * `http.request` writes one record. The first successful document wins;
 * a later action may record that URL again.
 *
 * Security note: ingested text is untrusted data that later reaches the
 * planner's prompt. Records carry `tags: ['ingested', …]` so a renderer can
 * fence or cap it; nothing here treats it as instructions.
 */
export class ObservationKnowledgeIngestor implements KnowledgeIngestor {
  private readonly maxContentChars: number;
  private readonly minContentChars: number;
  /** `${runId}\0${actionId}` → canonical document URLs already written. */
  private readonly documentsByAction = new Map<string, Set<string>>();

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
    const extracted = extract(
      observation.toolResult.toolName,
      observation.toolResult.output,
      input.action.input,
    );
    if ('skipped' in extracted) return { knowledge: [], skipped: extracted.skipped };

    const text = extracted.text.trim();
    if (text.length < this.minContentChars) {
      return { knowledge: [], skipped: `content too short (${text.length} chars)` };
    }
    if (
      extracted.url !== undefined &&
      !this.claimDocument(input.correlation.runId, input.action.actionId, extracted.url)
    ) {
      return { knowledge: [], skipped: 'same URL already ingested in this action' };
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

  /** @returns false when this action already stored a document from `url`. */
  private claimDocument(runId: string, actionId: ActionId, url: string): boolean {
    const scope = `${runId}\0${actionId}`;
    const key = canonicalUrl(url);
    let seen = this.documentsByAction.get(scope);
    if (!seen) {
      seen = new Set();
      this.documentsByAction.set(scope, seen);
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }
}

interface Extracted {
  readonly title: string;
  readonly text: string;
  readonly url?: string;
  readonly tags: readonly string[];
  readonly confidence: number;
}

const HTML_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const PLAIN_MEDIA_TYPES = new Set(['text/plain', 'text/markdown']);

function extract(
  toolName: string,
  output: unknown,
  actionInput: unknown,
): Extracted | { skipped: string } {
  if (!isRecord(output)) return { skipped: 'output is not an object' };
  switch (toolName) {
    case 'web.fetch':
      return extractWebFetch(output);
    case 'http.request':
      return extractHttpDocument(output, actionInput);
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

function extractWebFetch(output: Record<string, unknown>): Extracted | { skipped: string } {
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

/**
 * A public document the agent read through raw HTTP. Same provenance and
 * confidence as `web.fetch`. Anything that is not that document is refused
 * with a reason, so API payloads and binary responses stay out of knowledge.
 */
function extractHttpDocument(
  output: Record<string, unknown>,
  actionInput: unknown,
): Extracted | { skipped: string } {
  const status = output['status'];
  const body = output['body'];
  const url = typeof output['finalUrl'] === 'string' ? output['finalUrl'] : output['url'];
  if (typeof url !== 'string' || typeof body !== 'string' || typeof status !== 'number') {
    return { skipped: 'http.request output lacks url/status/body' };
  }
  if (status < 200 || status >= 400) return { skipped: `HTTP ${status} is not knowledge` };
  const method = httpMethod(actionInput);
  if (method !== undefined && method !== 'GET') {
    return { skipped: `HTTP ${method} is not a document read` };
  }
  if (looksBinary(body)) return { skipped: 'http.request body is binary' };

  const mediaType = contentMediaType(output['headers']);
  const kind = documentKind(mediaType, body);
  if (kind === undefined) {
    const allowed =
      mediaType === undefined ||
      HTML_MEDIA_TYPES.has(mediaType) ||
      PLAIN_MEDIA_TYPES.has(mediaType);
    return {
      skipped: allowed
        ? 'http.request body is not a document'
        : `content type ${mediaType} is not a document`,
    };
  }
  const page = kind === 'html' ? htmlToText(body) : { title: undefined, text: body };
  if (!isReadableDocument(page.text)) return { skipped: 'http.request body is not a document' };
  const title = page.title && page.title.trim() !== '' ? page.title.trim() : url;
  return { title, text: page.text, url, tags: [hostOf(url)].filter(Boolean), confidence: 0.5 };
}

function httpMethod(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const method = input['method'];
  if (typeof method !== 'string') return undefined;
  const normalized = method.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function contentMediaType(headers: unknown): string | undefined {
  if (!isRecord(headers)) return undefined;
  const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  if (typeof raw !== 'string') return undefined;
  const media = raw.split(';')[0]?.trim().toLowerCase();
  return media && media.length > 0 ? media : undefined;
}

function documentKind(mediaType: string | undefined, body: string): 'html' | 'plain' | undefined {
  if (mediaType !== undefined) {
    if (HTML_MEDIA_TYPES.has(mediaType)) return 'html';
    if (PLAIN_MEDIA_TYPES.has(mediaType)) return looksLikeJson(body) ? undefined : 'plain';
    return undefined;
  }
  return looksLikeHtml(body) && !looksLikeJson(body) ? 'html' : undefined;
}

function looksLikeHtml(body: string): boolean {
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<title[\s>]/i.test(body);
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function looksBinary(body: string): boolean {
  if (body.includes('\0')) return true;
  const sample = body.slice(0, 2000);
  if (sample.length === 0) return false;
  let controls = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    const text = code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    if (!text) controls++;
  }
  return controls / sample.length > 0.05;
}

/** Prose, not a token blob: several words, in any script. */
function isReadableDocument(text: string): boolean {
  return (text.match(/\p{L}{2,}/gu) ?? []).length >= 5;
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.href;
  } catch {
    return url.trim();
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
