import { parseFail, parseOk } from '../../domain/parse.js';
import type { Tool } from '../contracts.js';
import { optionalInteger, requireObject, requiredString } from '../support/input.js';

/**
 * Discovery/search is a locked V1 capability, but *which* search backend
 * (self-hosted metasearch queried from the sandbox, a keyed API, …) is an
 * open decision. This is the seam: the tool is real, the backend is
 * injected. No implementation ships in `src/` until that decision is made;
 * the catalogue simply omits `web.search` when no provider is configured.
 */
export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, options: { readonly limit: number }): Promise<readonly SearchResult[]>;
}

export interface WebSearchInput {
  readonly query: string;
  readonly limit: number;
}

export interface WebSearchOutput {
  readonly provider: string;
  readonly query: string;
  readonly results: readonly SearchResult[];
}

const MAX_RESULTS = 20;

export function createWebSearchTool(
  provider: SearchProvider,
): Tool<WebSearchInput, WebSearchOutput> {
  return {
    name: 'web.search',
    family: 'web',
    description: 'Search the web and return result titles, URLs and snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', description: `Max results (default 5, at most ${MAX_RESULTS})` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        query: { type: 'string' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              url: { type: 'string' },
              snippet: { type: 'string' },
            },
          },
        },
      },
    },
    parseInput(raw) {
      const object = requireObject(raw);
      if (!object.ok) return object;
      const errors: string[] = [];
      const query = requiredString(object.value, 'query', errors);
      const limit =
        optionalInteger(object.value, 'limit', errors, { min: 1, max: MAX_RESULTS }) ?? 5;
      if (errors.length > 0) return parseFail(...errors);
      return parseOk({ query: query.trim(), limit });
    },
    async execute(input) {
      const results = await provider.search(input.query, { limit: input.limit });
      return {
        provider: provider.name,
        query: input.query,
        results: results.slice(0, input.limit),
      };
    },
  };
}
