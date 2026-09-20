import { parseFail, parseOk } from '../../domain/parse.js';
import type { Tool } from '../contracts.js';
import { curlRequest, validateUrl } from '../http/curl-client.js';
import { optionalInteger, requireObject, requiredString } from '../support/input.js';
import { clampTimeout, type ToolOptions } from '../support/options.js';
import { capText } from '../support/output.js';
import { htmlToText } from './html-to-text.js';

export interface WebFetchInput {
  readonly url: string;
  readonly maxChars: number;
  readonly timeoutMs: number;
}

export interface WebFetchOutput {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string | undefined;
  readonly title: string | undefined;
  readonly text: string;
  readonly truncated: boolean;
  readonly bodyBytes: number;
}

/**
 * Fetches a web page from inside the sandbox and returns its readable text.
 * HTML is reduced to text; anything else is returned as-is. A 404 is a
 * result the model needs to see, not a tool failure.
 */
export function createWebFetchTool(options: ToolOptions): Tool<WebFetchInput, WebFetchOutput> {
  return {
    name: 'web.fetch',
    family: 'web',
    description: 'Fetch a web page from inside the sandbox and return its title and readable text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http:// or https:// URL' },
        maxChars: { type: 'integer', description: 'Cap on returned text characters' },
        timeoutMs: { type: 'integer' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        finalUrl: { type: 'string' },
        status: { type: 'integer' },
        contentType: { type: 'string' },
        title: { type: 'string' },
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        bodyBytes: { type: 'integer' },
      },
    },
    parseInput(raw) {
      const object = requireObject(raw);
      if (!object.ok) return object;
      const errors: string[] = [];
      const urlInput = requiredString(object.value, 'url', errors);
      const maxChars = optionalInteger(object.value, 'maxChars', errors, { min: 1 });
      const timeout = optionalInteger(object.value, 'timeoutMs', errors, { min: 1 });
      if (errors.length > 0) return parseFail(...errors);
      const url = validateUrl(urlInput);
      if (!url.ok) return url;
      return parseOk({
        url: url.value,
        maxChars: Math.min(options.maxOutputChars, maxChars ?? options.maxOutputChars),
        timeoutMs: clampTimeout(options, timeout),
      });
    },
    async execute(input, context) {
      const response = await curlRequest(context, options, {
        url: input.url,
        method: 'GET',
        headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
        timeoutMs: input.timeoutMs,
        // Read more than we return so that text extraction has the markup to work with.
        maxBodyChars: Math.min(options.maxOutputChars * 8, input.maxChars * 8),
      });
      const contentType = response.headers['content-type'];
      const isHtml = contentType === undefined || /html|xml/i.test(contentType);
      const page = isHtml ? htmlToText(response.body) : { title: undefined, text: response.body };
      const capped = capText(page.text, input.maxChars);
      return {
        url: input.url,
        finalUrl: response.finalUrl,
        status: response.status,
        contentType,
        title: page.title,
        text: capped.text,
        truncated: capped.truncated || response.bodyTruncated,
        bodyBytes: response.bodyBytes,
      };
    },
  };
}
