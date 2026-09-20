import { describe, expect, it } from 'vitest';
import { CloudflareSandboxEnvironment } from '../../src/sandbox/cloudflare/cloudflare-sandbox-environment.js';
import { readGatewayConfig } from '../../src/sandbox/cloudflare/config.js';
import {
  HttpSandboxClient,
  type FetchLike,
} from '../../src/sandbox/cloudflare/http-sandbox-client.js';
import { SandboxClientError } from '../../src/sandbox/cloudflare/sandbox-client.js';
import { createGatewayHandler } from '../../worker/src/gateway.js';
import { describeExecutionEnvironmentContract } from '../support/execution-environment-contract.js';
import { FakeSandboxClient } from '../support/fake-sandbox-client.js';

/**
 * TESTED ONLY WITH A FAKE CLIENT, IN PROCESS. The Node-side HTTP client is
 * wired straight into the gateway handler (no network), which in turn drives
 * a FakeSandboxClient. This proves the wire protocol round-trips every
 * operation and error kind. It is not evidence about Cloudflare.
 */

const TOKEN = 'unit-token-not-a-secret';
const URL_BASE = 'https://gateway.test/';

/** `null` = gateway deployed without its secret. */
function inProcess(gatewayToken: string | null = TOKEN) {
  const fake = new FakeSandboxClient('rt-1');
  const handler = createGatewayHandler({
    token: gatewayToken ?? undefined,
    sdkVersion: '0.12.9',
    clientFor: () => fake,
  });
  const fetchImpl: FetchLike = (input, init) => handler(new Request(input, init));
  const make = (token = TOKEN) =>
    new HttpSandboxClient({ gatewayUrl: URL_BASE, token, sandboxId: 'rt-1', fetch: fetchImpl });
  return { fake, make, fetchImpl };
}

describeExecutionEnvironmentContract(
  'cloudflare adapter over HttpSandboxClient → gateway → FakeSandboxClient',
  async () => new CloudflareSandboxEnvironment(inProcess().make()),
);

describe('HttpSandboxClient · protocol round trip', () => {
  it('performs every operation through the gateway', async () => {
    const { fake, make } = inProcess();
    const client = make();
    expect(await client.exec(`printf 'hi'`, { cwd: '/workspace' })).toEqual({
      exitCode: 0,
      stdout: 'hi',
      stderr: '',
    });
    await client.mkdir('/workspace/d', true);
    await client.writeFile('/workspace/d/f.txt', 'content');
    expect(await client.exists('/workspace/d/f.txt')).toBe(true);
    expect(await client.readFile('/workspace/d/f.txt')).toBe('content');
    expect((await client.listFiles('/workspace/d')).map((e) => e.name)).toEqual(['f.txt']);
    await client.deleteFile('/workspace/d/f.txt');
    expect(await client.exists('/workspace/d/f.txt')).toBe(false);

    const proc = await client.startProcess('sleep 100', { autoCleanup: false });
    expect((await client.listProcesses()).map((p) => p.id)).toEqual([proc.id]);
    await client.killProcess(proc.id);
    expect((await client.listProcesses())[0]?.status).toBe('killed');

    expect(await client.info()).toEqual({
      sandboxId: 'rt-1',
      placementId: null,
      sdkVersion: 'fake',
    });
    await client.destroy();
    expect(fake.destroyed).toBe(true);
  });

  it('sends the bearer token and JSON body, and strips trailing slashes from the base URL', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const client = new HttpSandboxClient({
      gatewayUrl: 'https://gw.example///',
      token: TOKEN,
      sandboxId: 'sb',
      fetch: async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ ok: true, result: { exists: true } }));
      },
    });
    expect(await client.exists('/x')).toBe(true);
    expect(seen?.url).toBe('https://gw.example/v1/sandboxes/sb/exists');
    expect((seen?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(seen?.init.body).toBe(JSON.stringify({ path: '/x' }));
  });

  it('re-raises gateway errors as SandboxClientError with the original kind', async () => {
    const { make } = inProcess();
    const client = make();
    await expect(client.readFile('/missing')).rejects.toMatchObject({
      name: 'SandboxClientError',
      kind: 'file_not_found',
      detail: { sdkErrorName: 'FileNotFoundError' },
    });
    await expect(client.killProcess('ghost')).rejects.toMatchObject({ kind: 'process_not_found' });
  });

  it('reports a wrong token as unauthorized', async () => {
    const { make } = inProcess();
    await expect(make('wrong').info()).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('reports an unconfigured gateway secret as unauthorized (fail closed)', async () => {
    const { make } = inProcess(null);
    await expect(make().info()).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('classifies transport failures', async () => {
    const unreachable = new HttpSandboxClient({
      gatewayUrl: URL_BASE,
      token: TOKEN,
      sandboxId: 'sb',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(unreachable.info()).rejects.toMatchObject({ kind: 'protocol' });

    const timingOut = new HttpSandboxClient({
      gatewayUrl: URL_BASE,
      token: TOKEN,
      sandboxId: 'sb',
      fetch: async () => {
        const error = new Error('aborted');
        error.name = 'TimeoutError';
        throw error;
      },
    });
    await expect(timingOut.info()).rejects.toMatchObject({ kind: 'request_timeout' });

    const html = new HttpSandboxClient({
      gatewayUrl: URL_BASE,
      token: TOKEN,
      sandboxId: 'sb',
      fetch: async () => new Response('<html>oops</html>', { status: 502 }),
    });
    await expect(html.info()).rejects.toMatchObject({ kind: 'protocol' });

    const malformed = new HttpSandboxClient({
      gatewayUrl: URL_BASE,
      token: TOKEN,
      sandboxId: 'sb',
      fetch: async () => new Response(JSON.stringify({ hello: 'world' })),
    });
    await expect(malformed.info()).rejects.toBeInstanceOf(SandboxClientError);
  });

  it('refuses to be constructed without a URL or token', () => {
    expect(() => new HttpSandboxClient({ gatewayUrl: '', token: 't', sandboxId: 's' })).toThrow();
    expect(
      () => new HttpSandboxClient({ gatewayUrl: URL_BASE, token: '', sandboxId: 's' }),
    ).toThrow();
  });
});

describe('gateway config from environment', () => {
  it('reports missing variable NAMES, never values', () => {
    expect(readGatewayConfig({})).toEqual({
      configured: false,
      missing: ['AGENT_SANDBOX_GATEWAY_URL', 'AGENT_SANDBOX_GATEWAY_TOKEN'],
    });
    expect(readGatewayConfig({ AGENT_SANDBOX_GATEWAY_URL: 'https://x' })).toEqual({
      configured: false,
      missing: ['AGENT_SANDBOX_GATEWAY_TOKEN'],
    });
    expect(
      readGatewayConfig({
        AGENT_SANDBOX_GATEWAY_URL: ' https://x ',
        AGENT_SANDBOX_GATEWAY_TOKEN: 't',
      }),
    ).toEqual({ configured: true, config: { gatewayUrl: 'https://x', token: 't' } });
  });
});
