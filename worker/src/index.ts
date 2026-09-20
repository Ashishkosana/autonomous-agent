import type { Sandbox } from '@cloudflare/sandbox';
import { createGatewayHandler } from './gateway.js';
import { SdkSandboxClient } from './sdk-sandbox-client.js';

/**
 * The Sandbox Durable Object class must be exported from the Worker that
 * declares the container binding. It is Cloudflare's class, unchanged.
 */
export { Sandbox } from '@cloudflare/sandbox';

/** Must match the version pinned in package.json AND the container image tag in wrangler.jsonc. */
export const SANDBOX_SDK_VERSION = '0.12.9';

interface Env {
  readonly Sandbox: DurableObjectNamespace<Sandbox>;
  /** Secret (wrangler secret put). Absent → gateway refuses all sandbox calls. */
  readonly AGENT_SANDBOX_GATEWAY_TOKEN?: string;
  /** Plain var: idle time before a container stops, e.g. "5m". */
  readonly AGENT_SANDBOX_SLEEP_AFTER?: string;
}

/**
 * Gateway Worker: the composition layer that gives hosts outside Cloudflare
 * (the Node test-suite today; the agent runtime wherever it ends up living)
 * authenticated access to the Sandbox SDK. It contains no agent logic.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handler = createGatewayHandler({
      token: env.AGENT_SANDBOX_GATEWAY_TOKEN,
      sdkVersion: SANDBOX_SDK_VERSION,
      clientFor: (sandboxId) =>
        new SdkSandboxClient(env.Sandbox, sandboxId, {
          sdkVersion: SANDBOX_SDK_VERSION,
          ...(env.AGENT_SANDBOX_SLEEP_AFTER ? { sleepAfter: env.AGENT_SANDBOX_SLEEP_AFTER } : {}),
        }),
    });
    return handler(request);
  },
};
