import { describe, expect, it } from 'vitest';
import { asActionId, asGoalId, asRunId } from '../../src/domain/ids.js';
import { SystemClock } from '../../src/domain/system-clock.js';
import type { AnyAgentEvent } from '../../src/events/contracts.js';
import { RunEventFactory } from '../../src/events/factory.js';
import type { ExecutionEnvironment } from '../../src/sandbox/execution-environment.js';
import type { ToolContext, ToolResult } from '../../src/tools/contracts.js';
import { invokeTool } from '../../src/tools/registry.js';
import { createStandardToolRegistry } from '../../src/tools/standard-tools.js';
import type { CommandOutcome } from '../../src/tools/support/command.js';
import type { HttpResponse } from '../../src/tools/http/curl-client.js';
import type { WebFetchOutput } from '../../src/tools/web/web-fetch-tool.js';
import { SequentialIdGenerator } from './deterministic.js';
import { InMemoryEventBus } from './in-memory-event-bus.js';

/**
 * The standard tools against a REAL ExecutionEnvironment: real coreutils,
 * python3, node, git and curl inside whatever Linux the environment provides.
 * Run over Linux namespaces in CI/cloud (scripts + interpreters proven, no
 * isolation claimed) and over Docker on a developer machine (`npm run
 * test:local`, isolation proven by the Phase 3B suite).
 *
 * The HTTP server the http/web tools talk to runs INSIDE the sandbox as a
 * background process, so the same suite is valid whatever the network
 * topology between test runner and sandbox is.
 */

export interface RealToolsHarness {
  readonly env: ExecutionEnvironment;
  readonly events: InMemoryEventBus;
  invoke(tool: string, input: unknown): Promise<ToolResult<unknown>>;
  ok<T>(tool: string, input: unknown): Promise<T>;
}

export function realToolsHarness(
  env: ExecutionEnvironment,
  options: { maxOutputChars?: number } = {},
): RealToolsHarness {
  const ids = new SequentialIdGenerator();
  const clock = new SystemClock();
  const events = new InMemoryEventBus();
  const runId = asRunId('run-real');
  const goalId = asGoalId('goal-real');
  const factory = new RunEventFactory(runId, goalId, ids, clock);
  const registry = createStandardToolRegistry({
    options: { maxOutputChars: options.maxOutputChars ?? 4_000, defaultTimeoutMs: 30_000 },
  });
  const invoke = (tool: string, input: unknown) => {
    const actionId = asActionId(ids.next('act'));
    const context: ToolContext = {
      correlation: { runId, goalId },
      actionId,
      environment: env,
      emit: (type, payload) =>
        events.emit(factory.create(type, payload, { actionId }) as unknown as AnyAgentEvent),
      clock,
      ids,
    };
    return invokeTool(registry, tool, input, context);
  };
  return {
    env,
    events,
    invoke,
    async ok<T>(tool: string, input: unknown): Promise<T> {
      const result = await invoke(tool, input);
      expect(result.status, JSON.stringify(result, null, 1)).toBe('ok');
      if (result.status !== 'ok') throw new Error('unreachable');
      return result.output as T;
    },
  };
}

export const TEST_HTTP_SERVER_SOURCE = String.raw`
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, status, ctype, body):
        self.send_response(status); self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == '/page':
            self.reply(200, 'text/html; charset=utf-8', b'<html><head><title>Sandbox Page</title><style>h1{}</style></head><body><h1>Hello from the sandbox</h1><p>Paragraph &amp; one.</p><script>var x=1;</script></body></html>')
        elif self.path == '/json':
            self.reply(200, 'application/json', json.dumps({'ok': True, 'ua': self.headers.get('User-Agent', '')}).encode())
        elif self.path == '/redirect':
            self.send_response(302); self.send_header('Location', '/json'); self.send_header('Content-Length', '0'); self.end_headers()
        elif self.path == '/big':
            self.reply(200, 'text/plain', b'x' * 200000)
        else:
            self.reply(404, 'text/plain', b'not here')
    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0')); data = self.rfile.read(n)
        self.reply(200, 'application/json', json.dumps({'received': data.decode(), 'contentType': self.headers.get('Content-Type')}).encode())
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
`;

/** Starts the in-sandbox HTTP server and waits until it answers. Returns the base URL. */
export async function startInSandboxHttpServer(
  env: ExecutionEnvironment,
  port: number,
): Promise<{ baseUrl: string; processId: string }> {
  const path = '/workspace/.test/http-server.py';
  await env.writeFile(path, TEST_HTTP_SERVER_SOURCE);
  const handle = await env.startProcess(`python3 ${path} ${port}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = await env.runCommand(`curl -s -o /dev/null -w '%{http_code}' ${baseUrl}/json`, {
      timeoutMs: 5_000,
    });
    if (probe.stdout.trim() === '200') return { baseUrl, processId: handle.processId };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const state = await env.getState();
  throw new Error(
    `in-sandbox HTTP server did not come up on ${baseUrl}; processes: ${JSON.stringify(state.processes)}`,
  );
}

export interface RealSuiteOptions {
  readonly title: string;
  readonly open: () => Promise<ExecutionEnvironment>;
  readonly httpPort: number;
  /** Extra checks only a real container can answer (e.g. file owner). */
  readonly expectFileOwner?: string;
  readonly internet: boolean;
  readonly onEvidence?: (name: string, data: unknown) => void;
}

export function describeStandardToolsOnRealLinux(options: RealSuiteOptions): void {
  describe(`standard tools on real Linux: ${options.title}`, () => {
    const evidence: Record<string, unknown> = {};
    const record = (name: string, data: unknown) => {
      evidence[name] = data;
      options.onEvidence?.(name, data);
    };

    it('filesystem: write → read → list → delete against real files', async () => {
      const h = realToolsHarness(await options.open());
      const write = await h.ok<{ path: string; bytes: number; created: boolean }>('fs.write', {
        path: 'notes/hello.txt',
        content: 'héllo sandbox\n',
      });
      expect(write).toEqual({ path: '/workspace/notes/hello.txt', bytes: 15, created: true });
      const read = await h.ok<{ content: string }>('fs.read', {
        path: '/workspace/notes/hello.txt',
      });
      expect(read.content).toBe('héllo sandbox\n');
      const list = await h.ok<{ entries: { name: string; type: string; sizeBytes?: number }[] }>(
        'fs.list',
        { path: 'notes' },
      );
      expect(list.entries).toEqual([{ name: 'hello.txt', type: 'file', sizeBytes: 15 }]);
      if (options.expectFileOwner) {
        const owner = await h.env.runCommand(`stat -c '%U' /workspace/notes/hello.txt`);
        expect(owner.stdout.trim()).toBe(options.expectFileOwner);
      }
      await h.ok('fs.delete', { path: 'notes/hello.txt' });
      expect(await h.env.fileExists('/workspace/notes/hello.txt')).toBe(false);
      const missing = await h.invoke('fs.read', { path: 'notes/hello.txt' });
      expect(missing.status).toBe('error');
      if (missing.status === 'error') expect(missing.error.code).toBe('not_found');
      expect(h.events.events.map((e) => e.type)).toEqual(['FILE_CREATED', 'FILE_DELETED']);
      record('filesystem', {
        write,
        list: list.entries,
        events: h.events.events.map((e) => e.type),
      });
    });

    it('shell.run: real exit codes, stderr, stdin, cwd, and a real timeout that kills the process', async () => {
      const h = realToolsHarness(await options.open());
      const okRun = await h.ok<CommandOutcome>('shell.run', {
        command: 'printf "%s\\n" one two | wc -l',
        stdin: '',
      });
      expect(okRun).toMatchObject({ exitCode: 0, timedOut: false });
      expect(okRun.stdout.trim()).toBe('2');

      const failing = await h.ok<CommandOutcome>('shell.run', { command: 'echo bad >&2; exit 7' });
      expect(failing).toMatchObject({ exitCode: 7, stderr: 'bad\n' });

      const piped = await h.ok<CommandOutcome>('shell.run', {
        command: 'tr a-z A-Z',
        stdin: 'quiet please',
      });
      expect(piped.stdout).toBe('QUIET PLEASE');

      await h.env.writeFile('/workspace/sub/dir/marker', '');
      const cwd = await h.ok<CommandOutcome>('shell.run', { command: 'pwd; ls', cwd: 'sub/dir' });
      expect(cwd.stdout).toBe('/workspace/sub/dir\nmarker\n');

      const started = Date.now();
      const timedOut = await h.ok<CommandOutcome>('shell.run', {
        command: 'echo begin; sleep 30; echo never',
        timeoutMs: 1_500,
      });
      const elapsed = Date.now() - started;
      expect(timedOut).toMatchObject({ timedOut: true, exitCode: null });
      expect(timedOut.stdout).toBe('begin\n');
      expect(elapsed).toBeLessThan(15_000);
      let leftovers = '';
      for (let i = 0; i < 20; i += 1) {
        leftovers = (await h.env.runCommand('pgrep -f "[s]leep 30" | wc -l')).stdout.trim();
        if (leftovers === '0') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(leftovers).toBe('0');

      const finished = h.events.ofType('COMMAND_FINISHED').map((e) => e.payload);
      expect(finished.map((p) => p.exitCode)).toEqual([0, 7, 0, 0, null]);
      expect(finished[4]?.timedOut).toBe(true);
      record('shell', { okRun, failing, timedOut: { ...timedOut, elapsedMs: elapsed }, finished });
    });

    it('code.run: real python3, node and sh interpreters; a crash is exit 1 with the traceback, not a tool failure', async () => {
      const h = realToolsHarness(await options.open());
      const py = await h.ok<CommandOutcome & { sourcePath: string }>('code.run', {
        language: 'python',
        source: 'import sys\nprint(sum(range(1, 101)))\nprint(sys.argv[1:])\n',
        args: ['a b', 'c'],
      });
      expect(py.exitCode).toBe(0);
      expect(py.stdout).toBe("5050\n['a b', 'c']\n");
      expect(await h.env.fileExists(py.sourcePath)).toBe(true);

      const node = await h.ok<CommandOutcome>('code.run', {
        language: 'node',
        source:
          'process.stdin.on("data", d => process.stdout.write(String(d.toString().trim().length)))',
        stdin: 'twelve chars',
      });
      expect(node).toMatchObject({ exitCode: 0, stdout: '12' });

      const sh = await h.ok<CommandOutcome>('code.run', {
        language: 'sh',
        source: 'echo "$0 $#"; exit 3',
        args: ['x'],
      });
      expect(sh.exitCode).toBe(3);
      expect(sh.stdout).toMatch(/\.agent\/code\/act-\d+\.sh 1\n/);

      const crash = await h.ok<CommandOutcome>('code.run', {
        language: 'python',
        source: 'raise ValueError("nope")',
      });
      expect(crash.exitCode).toBe(1);
      expect(crash.stderr).toMatch(/Traceback[\s\S]*ValueError: nope/);
      record('code', { py, node, sh, crash });
    });

    describe('http and web tools against a server running inside the sandbox', () => {
      let h: RealToolsHarness;
      let baseUrl = '';
      let processId = '';

      it('starts a real HTTP server as a sandbox background process', async () => {
        h = realToolsHarness(await options.open());
        ({ baseUrl, processId } = await startInSandboxHttpServer(h.env, options.httpPort));
        const state = await h.env.getState();
        expect(
          state.processes.some((p) => p.processId === processId && p.status === 'running'),
        ).toBe(true);
      });

      it('http.request: GET JSON, POST body round-trip, redirect following, 404 as a result, and body capping', async () => {
        const get = await h.ok<HttpResponse>('http.request', {
          url: `${baseUrl}/json`,
          headers: { 'User-Agent': 'agent-test/1' },
        });
        expect(get.status).toBe(200);
        expect(get.headers['content-type']).toBe('application/json');
        expect(JSON.parse(get.body)).toEqual({ ok: true, ua: 'agent-test/1' });

        const post = await h.ok<HttpResponse>('http.request', {
          url: `${baseUrl}/echo`,
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: "it's a body\nwith two lines",
        });
        expect(post.status).toBe(200);
        expect(JSON.parse(post.body)).toEqual({
          received: "it's a body\nwith two lines",
          contentType: 'text/plain',
        });

        const redirected = await h.ok<HttpResponse>('http.request', { url: `${baseUrl}/redirect` });
        expect(redirected).toMatchObject({
          status: 200,
          redirects: 1,
          finalUrl: `${baseUrl}/json`,
        });

        const missing = await h.ok<HttpResponse>('http.request', { url: `${baseUrl}/nowhere` });
        expect(missing).toMatchObject({ status: 404, body: 'not here' });

        const big = await h.ok<HttpResponse>('http.request', {
          url: `${baseUrl}/big`,
          maxBodyChars: 100,
        });
        expect(big).toMatchObject({ status: 200, bodyBytes: 200_000, bodyTruncated: true });
        expect(big.body.length).toBeLessThan(200);
        expect(
          await h.env
            .runCommand('ls /workspace/.agent/http 2>/dev/null | wc -l')
            .then((r) => r.stdout.trim()),
        ).toBe('0');
        record('http', {
          get,
          post,
          redirected,
          missing,
          big: { ...big, body: `${big.body.slice(0, 20)}…` },
        });
      });

      it('http.request: a refused connection is a retryable tool failure, not a fabricated response', async () => {
        const refused = await h.invoke('http.request', {
          url: `http://127.0.0.1:${options.httpPort + 1}/`,
          timeoutMs: 5_000,
        });
        expect(refused.status).toBe('error');
        if (refused.status !== 'error') return;
        expect(refused.error.code).toBe('execution_failed');
        expect(refused.error.retryable).toBe(true);
        expect(refused.error.message).toMatch(/curl exit 7/);
        record('http-refused', refused.error.message);
      });

      it('web.fetch: real HTML reduced to title + text; non-HTML returned as text', async () => {
        const page = await h.ok<WebFetchOutput>('web.fetch', { url: `${baseUrl}/page` });
        expect(page).toMatchObject({
          status: 200,
          title: 'Sandbox Page',
          text: 'Hello from the sandbox\nParagraph & one.',
          contentType: 'text/html; charset=utf-8',
        });
        const json = await h.ok<WebFetchOutput>('web.fetch', { url: `${baseUrl}/json` });
        expect(json.title).toBeUndefined();
        expect(JSON.parse(json.text).ok).toBe(true);
        record('web-fetch', { page, json });
      });

      it('stops the in-sandbox server', async () => {
        await h.env.stopProcess(processId);
        const state = await h.env.getState();
        expect(state.processes.find((p) => p.processId === processId)?.status).not.toBe('running');
      });
    });

    it.skipIf(!options.internet)(
      'http.request reaches the public internet from inside the sandbox (AGENT_TEST_INTERNET=1)',
      async () => {
        const h = realToolsHarness(await options.open());
        const response = await h.ok<HttpResponse>('http.request', {
          url: 'https://example.com/',
          timeoutMs: 20_000,
        });
        expect(response.status).toBe(200);
        expect(response.body).toMatch(/Example Domain/);
        const fetched = await h.ok<WebFetchOutput>('web.fetch', {
          url: 'https://example.com/',
          timeoutMs: 20_000,
        });
        expect(fetched.title).toBe('Example Domain');
        record('internet', {
          status: response.status,
          headers: response.headers,
          title: fetched.title,
          textPreview: fetched.text.slice(0, 120),
        });
      },
    );

    it('git: init → add → commit → log inside the sandbox with the fixed identity; push is refused before git runs', async () => {
      const h = realToolsHarness(await options.open());
      const init = await h.ok<CommandOutcome>('git', { args: ['init', '-q', 'repo'] });
      expect(init.exitCode).toBe(0);
      await h.ok('fs.write', { path: 'repo/README.md', content: '# sandbox repo\n' });
      expect(
        (await h.ok<CommandOutcome>('git', { args: ['add', 'README.md'], cwd: 'repo' })).exitCode,
      ).toBe(0);
      const commit = await h.ok<CommandOutcome>('git', {
        args: ['commit', '-q', '-m', 'first commit'],
        cwd: 'repo',
      });
      expect(commit.exitCode, commit.stderr).toBe(0);
      const log = await h.ok<CommandOutcome>('git', {
        args: ['log', '--format=%an <%ae> %s'],
        cwd: 'repo',
      });
      expect(log.stdout.trim()).toBe('agent <agent@sandbox.invalid> first commit');
      const status = await h.ok<CommandOutcome>('git', {
        args: ['status', '--porcelain'],
        cwd: 'repo',
      });
      expect(status.stdout).toBe('');
      const push = await h.invoke('git', { args: ['push', 'origin', 'main'], cwd: 'repo' });
      expect(push.status).toBe('error');
      if (push.status === 'error') expect(push.error.code).toBe('invalid_input');
      const commands = h.events.ofType('COMMAND_STARTED').map((e) => e.payload.command);
      expect(commands.some((c) => c.includes('push'))).toBe(false);
      record('git', { log: log.stdout, commands });
    });

    it('records the evidence bundle', () => {
      options.onEvidence?.('bundle', evidence);
      expect(Object.keys(evidence).length).toBeGreaterThan(4);
    });
  });
}
