import { describe, expect, it } from 'vitest';
import { SandboxClientError } from '../../src/sandbox/cloudflare/sandbox-client.js';
import { createGatewayHandler, validateRequest } from '../../worker/src/gateway.js';
import { FakeSandboxClient } from '../support/fake-sandbox-client.js';

/**
 * TESTED ONLY WITH A FAKE CLIENT, IN NODE. The gateway handler is platform
 * neutral (Fetch API only), so its authentication, routing, validation and
 * error serialisation are proven here. Whether it behaves the same on the
 * Workers runtime is proven by the credential-gated integration tests.
 */

const TOKEN = 'test-token-not-a-real-secret';
const BASE = 'https://gateway.test';

/** `null` = gateway deployed without its secret. */
function harness(token: string | null = TOKEN) {
  const clients = new Map<string, FakeSandboxClient>();
  const handler = createGatewayHandler({
    token: token ?? undefined,
    sdkVersion: '0.12.9',
    clientFor: (id) => {
      let client = clients.get(id);
      if (!client) {
        client = new FakeSandboxClient(id);
        clients.set(id, client);
      }
      return client;
    },
  });
  /** `auth: null` = send no Authorization header at all. */
  const post = (path: string, body: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
    handler(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(auth !== null ? { authorization: auth } : {}),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  return { handler, clients, post };
}

describe('gateway handler · health and auth', () => {
  it('answers /health without auth and never reveals the secret', async () => {
    const { handler } = harness();
    const response = await handler(new Request(`${BASE}/health`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      service: 'agent-sandbox-gateway',
      sdkVersion: '0.12.9',
      authConfigured: true,
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('fails closed with 503 when no secret is configured', async () => {
    const { post } = harness(null);
    const response = await post('/v1/sandboxes/abc/info', {});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { kind: 'unauthorized' } });
  });

  it('rejects missing, malformed and wrong bearer tokens with 401', async () => {
    const { post } = harness();
    expect((await post('/v1/sandboxes/abc/info', {}, null)).status).toBe(401);
    expect((await post('/v1/sandboxes/abc/info', {}, 'Basic abc')).status).toBe(401);
    expect((await post('/v1/sandboxes/abc/info', {}, 'Bearer wrong')).status).toBe(401);
    expect((await post('/v1/sandboxes/abc/info', {}, `Bearer ${TOKEN}x`)).status).toBe(401);
  });

  it('accepts a case-insensitive scheme with the exact token', async () => {
    const { post } = harness();
    expect((await post('/v1/sandboxes/abc/info', {}, `bearer ${TOKEN}`)).status).toBe(200);
  });
});

describe('gateway handler · routing and validation', () => {
  it('returns 404 for unknown routes and operations, 405 for non-POST', async () => {
    const { handler, post } = harness();
    expect((await handler(new Request(`${BASE}/nope`))).status).toBe(404);
    expect((await post('/v1/sandboxes/abc/teleport', {})).status).toBe(404);
    const get = await handler(
      new Request(`${BASE}/v1/sandboxes/abc/info`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(get.status).toBe(405);
  });

  it('rejects invalid sandbox ids before touching any client', async () => {
    const { post, clients } = harness();
    const response = await post('/v1/sandboxes/Not-Lower/info', {});
    expect(response.status).toBe(400);
    expect(clients.size).toBe(0);
  });

  it('rejects non-JSON and malformed bodies with 400', async () => {
    const { post } = harness();
    expect((await post('/v1/sandboxes/abc/exec', '{not json')).status).toBe(400);
    const bad = await post('/v1/sandboxes/abc/exec', { command: '' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      ok: false,
      error: { kind: 'invalid_request', message: 'command must be a non-empty string' },
    });
    expect((await post('/v1/sandboxes/abc/readFile', { path: 'relative' })).status).toBe(400);
    expect((await post('/v1/sandboxes/abc/mkdir', { path: '/x' })).status).toBe(400);
    expect(
      (await post('/v1/sandboxes/abc/exec', { command: 'ls', options: { timeoutMs: -1 } })).status,
    ).toBe(400);
    expect(
      (await post('/v1/sandboxes/abc/exec', { command: 'ls', options: { autoCleanup: true } }))
        .status,
    ).toBe(400);
  });

  it('validates option shapes for exec and startProcess', () => {
    expect(validateRequest('exec', { command: 'ls', options: { env: { A: 1 } } })).toMatchObject({
      ok: false,
    });
    expect(
      validateRequest('startProcess', {
        command: 'ls',
        options: { cwd: '/w', env: { A: 'b' }, timeoutMs: 5, autoCleanup: false },
      }),
    ).toEqual({
      ok: true,
      body: {
        command: 'ls',
        options: { cwd: '/w', env: { A: 'b' }, timeoutMs: 5, autoCleanup: false },
      },
    });
    expect(validateRequest('killProcess', { processId: 'p1', signal: 'SIGKILL' })).toEqual({
      ok: true,
      body: { processId: 'p1', signal: 'SIGKILL' },
    });
  });
});

describe('gateway handler · dispatch and error serialisation', () => {
  it('routes each operation to the sandbox named in the path', async () => {
    const { post, clients } = harness();
    const exec = await post('/v1/sandboxes/run-1/exec', { command: `printf 'ok'` });
    expect(await exec.json()).toEqual({
      ok: true,
      result: { exitCode: 0, stdout: 'ok', stderr: '' },
    });
    await post('/v1/sandboxes/run-1/writeFile', { path: '/workspace/a.txt', content: 'A' });
    const read = await post('/v1/sandboxes/run-1/readFile', { path: '/workspace/a.txt' });
    expect(await read.json()).toEqual({ ok: true, result: { content: 'A' } });
    const exists = await post('/v1/sandboxes/run-2/exists', { path: '/workspace/a.txt' });
    expect(await exists.json()).toEqual({ ok: true, result: { exists: false } });
    expect([...clients.keys()]).toEqual(['run-1', 'run-2']);
  });

  it('serialises normalised client errors with a matching HTTP status', async () => {
    const { post } = harness();
    const response = await post('/v1/sandboxes/run-1/readFile', { path: '/missing' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        kind: 'file_not_found',
        message: 'ENOENT /missing',
        sdkErrorName: 'FileNotFoundError',
      },
    });
  });

  it('maps container unavailability to 503 and unexpected errors to 500', async () => {
    const { post, clients } = harness();
    await post('/v1/sandboxes/run-1/info', {});
    const client = clients.get('run-1')!;
    client.failWith = new SandboxClientError('cold start', 'container_unavailable');
    expect((await post('/v1/sandboxes/run-1/info', {})).status).toBe(503);
    client.failWith = undefined;
    client.setCommandScript(() => {
      throw new TypeError('unexpected');
    });
    const response = await post('/v1/sandboxes/run-1/exec', { command: 'ls' });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { kind: 'unknown', message: 'TypeError: unexpected' },
    });
  });
});
