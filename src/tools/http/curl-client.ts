import { parseFail, parseOk, type ParseResult } from '../../domain/parse.js';
import type { ToolContext } from '../contracts.js';
import { capText } from '../support/output.js';
import type { ToolOptions } from '../support/options.js';
import { shellJoin, shellQuote } from '../support/shell.js';

/**
 * HTTP from inside the sandbox, via curl(1). The request leaves through the
 * sandbox's network, so whatever egress policy the environment enforces
 * (Docker network, Cloudflare egress rules) applies to the agent's traffic —
 * this module adds validation, not a second network stack on the host.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface HttpRequestSpec {
  readonly url: string;
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxBodyChars: number;
}

export interface HttpResponse {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly bodyBytes: number;
  readonly redirects: number;
  readonly durationMs: number;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function validateUrl(raw: string): ParseResult<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return parseFail(`url is not a valid absolute URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return parseFail(`url scheme must be http or https, got ${url.protocol.replace(':', '')}`);
  }
  if (url.username !== '' || url.password !== '') {
    return parseFail('url must not embed credentials');
  }
  return parseOk(url.toString());
}

export function validateHeaders(
  headers: Readonly<Record<string, string>>,
): ParseResult<Record<string, string>> {
  const errors: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) errors.push(`invalid header name: ${JSON.stringify(name)}`);
    if (value.length === 0) errors.push(`header ${name} must not be empty`);
    if (/[\r\n]/.test(value)) errors.push(`header ${name} must not contain line breaks`);
  }
  return errors.length > 0 ? parseFail(...errors) : parseOk({ ...headers });
}

/** Builds the curl argv for a validated request; exported so tests can pin the exact flags. */
export function curlArgv(
  spec: HttpRequestSpec,
  files: { readonly body: string; readonly headers: string; readonly request?: string },
): string[] {
  const argv = [
    'curl',
    '-sS',
    '-L',
    '--max-redirs',
    '5',
    '--proto',
    '=http,https',
    '--proto-redir',
    '=http,https',
    '--max-time',
    String(Math.max(1, Math.ceil(spec.timeoutMs / 1000))),
    '-o',
    files.body,
    '-D',
    files.headers,
    '-w',
    '%{http_code} %{num_redirects} %{url_effective}',
  ];
  if (spec.method === 'HEAD') argv.push('-I');
  else if (spec.method !== 'GET') argv.push('-X', spec.method);
  for (const [name, value] of Object.entries(spec.headers)) argv.push('-H', `${name}: ${value}`);
  if (files.request !== undefined) argv.push('--data-binary', `@${files.request}`);
  argv.push(spec.url);
  return argv;
}

export async function curlRequest(
  context: ToolContext,
  options: ToolOptions,
  spec: HttpRequestSpec,
): Promise<HttpResponse> {
  const base = `${options.workspaceRoot}/${options.scratchDir}/http/${context.actionId}`;
  const files = {
    body: `${base}.body`,
    headers: `${base}.hdr`,
    ...(spec.body !== undefined ? { request: `${base}.req` } : {}),
  };
  if (files.request !== undefined && spec.body !== undefined) {
    await context.environment.writeFile(files.request, spec.body);
  }
  const delimiter = `__AGENT_HTTP_${context.actionId}__`;
  // `head -c` bounds what comes back even for huge bodies; `wc -c` reports the true size.
  const script = [
    `mkdir -p ${shellQuote(`${options.workspaceRoot}/${options.scratchDir}/http`)}`,
    `${shellJoin(curlArgv(spec, files))}; ec=$?`,
    `printf '\\n%s %s\\n' ${shellQuote(delimiter)} "$ec"`,
    `cat ${shellQuote(files.headers)} 2>/dev/null`,
    `printf '\\n%s\\n' ${shellQuote(delimiter)}`,
    `wc -c < ${shellQuote(files.body)} 2>/dev/null || echo 0`,
    `printf '%s\\n' ${shellQuote(delimiter)}`,
    `head -c ${String(spec.maxBodyChars * 4)} ${shellQuote(files.body)} 2>/dev/null`,
    `rm -f ${shellJoin(Object.values(files))}`,
  ].join('; ');

  const result = await context.environment.runCommand(script, {
    cwd: options.workspaceRoot,
    timeoutMs: spec.timeoutMs + 5_000,
  });
  if (result.timedOut) {
    throw new Error(`HTTP request to ${spec.url} did not finish within ${spec.timeoutMs}ms`);
  }
  return parseCurlOutput(spec, delimiter, result.stdout, result.stderr, result.durationMs);
}

export function parseCurlOutput(
  spec: HttpRequestSpec,
  delimiter: string,
  stdout: string,
  stderr: string,
  durationMs: number,
): HttpResponse {
  const first = stdout.indexOf(`\n${delimiter} `);
  if (first === -1) throw new Error(`curl produced no result marker (stderr: ${stderr.trim()})`);
  const writeOut = stdout.slice(0, first);
  const afterMarker = stdout.slice(first + delimiter.length + 2);
  const newline = afterMarker.indexOf('\n');
  const exitCode = Number(afterMarker.slice(0, newline).trim());
  const rest = afterMarker.slice(newline + 1);
  const parts = rest.split(`\n${delimiter}\n`);
  const headersText = parts[0] ?? '';
  const bodyBytes = Number((parts[1] ?? '0').trim()) || 0;
  const bodyRaw = parts.slice(2).join(`\n${delimiter}\n`);

  const [statusText = '0', redirectsText = '0', ...finalParts] = writeOut.trim().split(' ');
  const status = Number(statusText) || 0;
  if (exitCode !== 0 && status === 0) {
    throw new Error(
      `curl exit ${exitCode} for ${spec.method} ${spec.url}: ${stderr.trim() || 'no detail'}`,
    );
  }
  const body = capText(bodyRaw, spec.maxBodyChars);
  return {
    url: spec.url,
    finalUrl: finalParts.join(' ') || spec.url,
    status,
    headers: parseLastHeaderBlock(headersText),
    body: body.text,
    bodyTruncated: body.truncated || bodyBytes > bodyRaw.length,
    bodyBytes,
    redirects: Number(redirectsText) || 0,
    durationMs,
  };
}

/** `curl -D` appends one block per hop; only the final response's headers describe the body. */
export function parseLastHeaderBlock(text: string): Record<string, string> {
  const blocks = text
    .replaceAll('\r\n', '\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const last = blocks.at(-1);
  if (!last) return {};
  const headers: Record<string, string> = {};
  for (const line of last.split('\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}
