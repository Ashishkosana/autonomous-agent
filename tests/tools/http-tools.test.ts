import { describe, expect, it } from 'vitest';
import {
  curlArgv,
  parseCurlOutput,
  parseLastHeaderBlock,
  validateHeaders,
  validateUrl,
  type HttpRequestSpec,
} from '../../src/tools/http/curl-client.js';
import { invokeTool } from '../../src/tools/registry.js';
import { createStandardToolRegistry } from '../../src/tools/standard-tools.js';
import { decodeEntities, htmlToText } from '../../src/tools/web/html-to-text.js';
import { makeHarness } from '../support/fixtures.js';

const spec: HttpRequestSpec = {
  url: 'https://example.test/path?q=1',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{"a":1}',
  timeoutMs: 4_500,
  maxBodyChars: 100,
};

describe('URL and header validation', () => {
  it('accepts http(s) without credentials and nothing else', () => {
    expect(validateUrl('https://example.test/a b')).toEqual({
      ok: true,
      value: 'https://example.test/a%20b',
    });
    expect(validateUrl('http://127.0.0.1:8080/').ok).toBe(true);
    for (const bad of [
      'ftp://x/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
      'https://u:p@host/',
    ]) {
      const result = validateUrl(bad);
      expect(result.ok, bad).toBe(false);
    }
  });

  it('rejects header injection', () => {
    expect(validateHeaders({ Accept: 'text/html' }).ok).toBe(true);
    expect(validateHeaders({ 'Bad Name': 'x' }).ok).toBe(false);
    expect(validateHeaders({ 'X-Test': 'a\r\nInjected: yes' }).ok).toBe(false);
    expect(validateHeaders({ 'X-Empty': '' }).ok).toBe(false);
  });
});

describe('curl argv', () => {
  it('pins the flags that make requests bounded and scheme-restricted', () => {
    const argv = curlArgv(spec, {
      body: '/w/.agent/http/a.body',
      headers: '/w/.agent/http/a.hdr',
      request: '/w/.agent/http/a.req',
    });
    expect(argv).toEqual([
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
      '5',
      '-o',
      '/w/.agent/http/a.body',
      '-D',
      '/w/.agent/http/a.hdr',
      '-w',
      '%{http_code} %{num_redirects} %{url_effective}',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      '@/w/.agent/http/a.req',
      'https://example.test/path?q=1',
    ]);
    expect(curlArgv({ ...spec, method: 'HEAD' }, { body: 'b', headers: 'h' })).toContain('-I');
    expect(curlArgv({ ...spec, method: 'GET' }, { body: 'b', headers: 'h' })).not.toContain('-X');
  });
});

describe('curl output parsing', () => {
  const delimiter = '__AGENT_HTTP_act-1__';
  const output = (writeOut: string, exit: number, headers: string, bytes: number, body: string) =>
    `${writeOut}\n${delimiter} ${exit}\n${headers}\n${delimiter}\n${bytes}\n${delimiter}\n${body}`;

  it('takes the last hop’s headers, the true byte count, and caps the body', () => {
    const headers =
      'HTTP/1.1 301 Moved Permanently\r\nLocation: /final\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n';
    const response = parseCurlOutput(
      spec,
      delimiter,
      output('200 1 https://example.test/final', 0, headers, 5000, 'x'.repeat(500)),
      '',
      12,
    );
    expect(response).toMatchObject({
      status: 200,
      redirects: 1,
      finalUrl: 'https://example.test/final',
      bodyBytes: 5000,
      bodyTruncated: true,
      durationMs: 12,
      headers: { 'content-type': 'text/plain', 'set-cookie': 'a=1, b=2' },
    });
    expect(response.body.length).toBeLessThan(150);
  });

  it('a 404 is a response; a transport failure is an error', () => {
    const notFound = parseCurlOutput(
      spec,
      delimiter,
      output('404 0 https://example.test/x', 0, 'HTTP/1.1 404 Not Found\r\n\r\n', 0, ''),
      '',
      1,
    );
    expect(notFound.status).toBe(404);
    expect(() =>
      parseCurlOutput(
        spec,
        delimiter,
        output('000 0 https://example.test/x', 6, '', 0, ''),
        'curl: (6) Could not resolve host',
        1,
      ),
    ).toThrow(/curl exit 6 .*Could not resolve host/);
    expect(() => parseCurlOutput(spec, delimiter, 'garbage', 'boom', 1)).toThrow(
      /no result marker/,
    );
  });

  it('parses header blocks defensively', () => {
    expect(parseLastHeaderBlock('')).toEqual({});
    expect(parseLastHeaderBlock('HTTP/2 200\ncontent-length: 3\nweird line\n')).toEqual({
      'content-length': '3',
    });
  });
});

describe('http.request input handling', () => {
  it('rejects bad URLs and headers before any command runs; clamps timeouts and body caps', async () => {
    const harness = makeHarness();
    const registry = createStandardToolRegistry({
      options: { maxOutputChars: 40, maxTimeoutMs: 3_000 },
    });
    const bad = await invokeTool(
      registry,
      'http.request',
      { url: 'file:///etc/passwd' },
      harness.toolContext(),
    );
    expect(bad.status).toBe('error');
    if (bad.status === 'error') expect(bad.error.code).toBe('invalid_input');
    const injected = await invokeTool(
      registry,
      'http.request',
      { url: 'https://example.test/', headers: { 'X-A': 'a\nb' } },
      harness.toolContext(),
    );
    expect(injected.status).toBe('error');
    expect(harness.environment.commandLog).toEqual([]);

    const tool = registry.get('http.request');
    const parsed = tool?.parseInput({
      url: 'https://example.test/',
      timeoutMs: 99_999,
      maxBodyChars: 5_000,
    });
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok)
      expect(parsed.value).toMatchObject({ method: 'GET', timeoutMs: 3_000, maxBodyChars: 40 });
  });
});

describe('html to text', () => {
  it('drops scripts and styles, keeps block structure, decodes entities, extracts the title', () => {
    const html = `<!doctype html><html><head><title> Hello &amp; welcome </title><style>p{}</style></head>
<body><script>alert(1)</script><h1>Heading</h1><p>First &lt;para&gt;&nbsp;with <b>bold</b> text.</p>
<!-- comment --><ul><li>one</li><li>two&#8230;</li></ul><div>tail &#x41;</div></body></html>`;
    expect(htmlToText(html)).toEqual({
      title: 'Hello & welcome',
      text: 'Heading\nFirst <para> with bold text.\none\ntwo…\ntail A',
    });
    expect(decodeEntities('&unknown; &#99999999;')).toBe('&unknown; &#99999999;');
  });

  it('returns plain text for pages without markup', () => {
    expect(htmlToText('just text')).toEqual({ title: undefined, text: 'just text' });
  });
});
