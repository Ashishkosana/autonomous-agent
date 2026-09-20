import { parseFail, parseOk } from '../../domain/parse.js';
import type { Tool } from '../contracts.js';
import {
  optionalEnum,
  optionalInteger,
  optionalString,
  optionalStringRecord,
  requireObject,
  requiredString,
} from '../support/input.js';
import { clampTimeout, type ToolOptions } from '../support/options.js';
import {
  curlRequest,
  HTTP_METHODS,
  validateHeaders,
  validateUrl,
  type HttpRequestSpec,
  type HttpResponse,
} from './curl-client.js';

/**
 * Raw HTTP request from inside the sandbox. Status codes — including 4xx/5xx —
 * are results, not errors; only a failed transport (DNS, refused connection,
 * timeout) makes the tool call fail.
 */
export function createHttpRequestTool(options: ToolOptions): Tool<HttpRequestSpec, HttpResponse> {
  return {
    name: 'http.request',
    family: 'http',
    description:
      'Send an HTTP(S) request from inside the sandbox and return status, headers and body text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http:// or https:// URL' },
        method: { type: 'string', enum: [...HTTP_METHODS], description: 'Default GET' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Request headers',
        },
        body: { type: 'string', description: 'Request body text (POST/PUT/PATCH)' },
        timeoutMs: { type: 'integer', description: `Max ${options.maxTimeoutMs}` },
        maxBodyChars: { type: 'integer', description: 'Cap on returned body characters' },
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
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string' },
        bodyTruncated: { type: 'boolean' },
        bodyBytes: { type: 'integer' },
        redirects: { type: 'integer' },
        durationMs: { type: 'integer' },
      },
    },
    parseInput(raw) {
      const object = requireObject(raw);
      if (!object.ok) return object;
      const errors: string[] = [];
      const urlInput = requiredString(object.value, 'url', errors);
      const method = optionalEnum(object.value, 'method', HTTP_METHODS, errors) ?? 'GET';
      const headersInput = optionalStringRecord(object.value, 'headers', errors);
      const body = optionalString(object.value, 'body', errors);
      const timeout = optionalInteger(object.value, 'timeoutMs', errors, { min: 1 });
      const maxBody = optionalInteger(object.value, 'maxBodyChars', errors, { min: 1 });
      if (errors.length > 0) return parseFail(...errors);
      const url = validateUrl(urlInput);
      if (!url.ok) return url;
      const headers = validateHeaders(headersInput);
      if (!headers.ok) return headers;
      return parseOk({
        url: url.value,
        method,
        headers: headers.value,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: clampTimeout(options, timeout),
        maxBodyChars: Math.min(options.maxOutputChars, maxBody ?? options.maxOutputChars),
      });
    },
    execute(input, context) {
      return curlRequest(context, options, input);
    },
  };
}
