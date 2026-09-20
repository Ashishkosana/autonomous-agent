import {
  GATEWAY_HEALTH_PATH,
  isGatewayOperation,
  isValidSandboxId,
  parseGatewayPath,
  statusForErrorKind,
  type GatewayErrorBody,
  type GatewayHealth,
  type GatewayOperation,
  type GatewayRequests,
  type GatewayResults,
} from '../../src/sandbox/cloudflare/protocol.js';
import {
  SandboxClientError,
  type SandboxClient,
  type SandboxExecOptions,
  type SandboxStartProcessOptions,
} from '../../src/sandbox/cloudflare/sandbox-client.js';

export interface GatewayDependencies {
  /** Bearer secret. `undefined` means not configured: the gateway then refuses every call (fail closed). */
  readonly token: string | undefined;
  readonly sdkVersion: string;
  clientFor(sandboxId: string): SandboxClient;
}

export type GatewayHandler = (request: Request) => Promise<Response>;

/**
 * Routes gateway HTTP requests to `SandboxClient` calls. Pure with respect to
 * the platform (uses only the Fetch API), so it is unit tested in Node with a
 * fake client and reused unchanged by the Worker entry point.
 */
export function createGatewayHandler(deps: GatewayDependencies): GatewayHandler {
  return async (request) => {
    const url = new URL(request.url);

    if (url.pathname === GATEWAY_HEALTH_PATH && request.method === 'GET') {
      const health: GatewayHealth = {
        ok: true,
        service: 'agent-sandbox-gateway',
        sdkVersion: deps.sdkVersion,
        authConfigured: deps.token !== undefined && deps.token.length > 0,
      };
      return json(health, 200);
    }

    const route = parseGatewayPath(url.pathname);
    if (!route) return failure('invalid_request', 'unknown route', 404);
    if (request.method !== 'POST') return failure('invalid_request', 'method not allowed', 405);

    if (!deps.token) {
      return failure(
        'unauthorized',
        'gateway secret AGENT_SANDBOX_GATEWAY_TOKEN is not configured; refusing all requests',
        503,
      );
    }
    if (!isAuthorized(request.headers.get('authorization'), deps.token)) {
      return failure('unauthorized', 'missing or invalid bearer token');
    }

    if (!isValidSandboxId(route.sandboxId)) {
      return failure('invalid_request', 'sandbox id must match ^[a-z0-9][a-z0-9-]{0,62}$');
    }
    if (!isGatewayOperation(route.operation)) {
      return failure('invalid_request', `unknown operation "${route.operation}"`, 404);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure('invalid_request', 'request body must be JSON');
    }
    const validation = validateRequest(route.operation, body);
    if (!validation.ok) return failure('invalid_request', validation.message);

    try {
      const client = deps.clientFor(route.sandboxId);
      const result = await dispatch(client, route.operation, validation.body);
      return json({ ok: true, result }, 200);
    } catch (error) {
      if (error instanceof SandboxClientError) {
        return failure(error.kind, error.message, undefined, error.detail);
      }
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return failure('unknown', message);
    }
  };
}

async function dispatch<TOp extends GatewayOperation>(
  client: SandboxClient,
  operation: TOp,
  body: GatewayRequests[TOp],
): Promise<GatewayResults[TOp]> {
  // Each branch narrows `body` by operation; the cast at the end re-widens to the mapped type.
  const run = async (): Promise<GatewayResults[GatewayOperation]> => {
    switch (operation) {
      case 'exec': {
        const b = body as GatewayRequests['exec'];
        return client.exec(b.command, b.options);
      }
      case 'startProcess': {
        const b = body as GatewayRequests['startProcess'];
        return client.startProcess(b.command, b.options);
      }
      case 'listProcesses':
        return client.listProcesses();
      case 'killProcess': {
        const b = body as GatewayRequests['killProcess'];
        await client.killProcess(b.processId, b.signal);
        return null;
      }
      case 'readFile': {
        const b = body as GatewayRequests['readFile'];
        return { content: await client.readFile(b.path) };
      }
      case 'writeFile': {
        const b = body as GatewayRequests['writeFile'];
        await client.writeFile(b.path, b.content);
        return null;
      }
      case 'mkdir': {
        const b = body as GatewayRequests['mkdir'];
        await client.mkdir(b.path, b.recursive);
        return null;
      }
      case 'deleteFile': {
        const b = body as GatewayRequests['deleteFile'];
        await client.deleteFile(b.path);
        return null;
      }
      case 'exists': {
        const b = body as GatewayRequests['exists'];
        return { exists: await client.exists(b.path) };
      }
      case 'listFiles': {
        const b = body as GatewayRequests['listFiles'];
        return client.listFiles(b.path);
      }
      case 'info':
        return client.info();
      case 'destroy':
        await client.destroy();
        return null;
      default:
        throw new SandboxClientError(`unhandled operation ${String(operation)}`, 'protocol');
    }
  };
  return (await run()) as GatewayResults[TOp];
}

type Validation<TOp extends GatewayOperation> =
  | { readonly ok: true; readonly body: GatewayRequests[TOp] }
  | { readonly ok: false; readonly message: string };

export function validateRequest<TOp extends GatewayOperation>(
  operation: TOp,
  body: unknown,
): Validation<TOp> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'request body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined;
  const fail = (message: string): Validation<TOp> => ({ ok: false, message });
  const ok = (value: unknown): Validation<TOp> => ({
    ok: true,
    body: value as GatewayRequests[TOp],
  });

  switch (operation) {
    case 'exec':
    case 'startProcess': {
      const command = str('command');
      if (command === undefined || command.length === 0)
        return fail('command must be a non-empty string');
      const options = validateExecOptions(record['options'], operation === 'startProcess');
      if (typeof options === 'string') return fail(options);
      return ok({ command, ...(options ? { options } : {}) });
    }
    case 'killProcess': {
      const processId = str('processId');
      if (!processId) return fail('processId must be a non-empty string');
      const signal = str('signal');
      return ok({ processId, ...(signal ? { signal } : {}) });
    }
    case 'readFile':
    case 'deleteFile':
    case 'exists':
    case 'listFiles': {
      const path = str('path');
      if (!path || !path.startsWith('/')) return fail('path must be an absolute path');
      return ok({ path });
    }
    case 'writeFile': {
      const path = str('path');
      if (!path || !path.startsWith('/')) return fail('path must be an absolute path');
      const content = str('content');
      if (content === undefined) return fail('content must be a string');
      return ok({ path, content });
    }
    case 'mkdir': {
      const path = str('path');
      if (!path || !path.startsWith('/')) return fail('path must be an absolute path');
      if (typeof record['recursive'] !== 'boolean') return fail('recursive must be a boolean');
      return ok({ path, recursive: record['recursive'] });
    }
    case 'listProcesses':
    case 'info':
    case 'destroy':
      return ok({});
    default:
      return fail(`unknown operation ${String(operation)}`);
  }
}

function validateExecOptions(
  value: unknown,
  allowAutoCleanup: boolean,
): SandboxExecOptions | SandboxStartProcessOptions | undefined | string {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) return 'options must be an object';
  const record = value as Record<string, unknown>;
  const out: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    autoCleanup?: boolean;
  } = {};
  if (record['cwd'] !== undefined) {
    if (typeof record['cwd'] !== 'string') return 'options.cwd must be a string';
    out.cwd = record['cwd'];
  }
  if (record['env'] !== undefined) {
    if (typeof record['env'] !== 'object' || record['env'] === null)
      return 'options.env must be an object';
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(record['env'] as Record<string, unknown>)) {
      if (typeof val !== 'string') return `options.env.${key} must be a string`;
      env[key] = val;
    }
    out.env = env;
  }
  if (record['timeoutMs'] !== undefined) {
    if (typeof record['timeoutMs'] !== 'number' || !(record['timeoutMs'] > 0)) {
      return 'options.timeoutMs must be a positive number';
    }
    out.timeoutMs = record['timeoutMs'];
  }
  if (record['autoCleanup'] !== undefined) {
    if (!allowAutoCleanup) return 'options.autoCleanup is only valid for startProcess';
    if (typeof record['autoCleanup'] !== 'boolean') return 'options.autoCleanup must be a boolean';
    out.autoCleanup = record['autoCleanup'];
  }
  return out;
}

function isAuthorized(header: string | null, token: string): boolean {
  if (!header) return false;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return false;
  return constantTimeEqual(rest.join(' ').trim(), token);
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i += 1) diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  return diff === 0;
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function failure(
  kind: GatewayErrorBody['kind'],
  message: string,
  status: number = statusForErrorKind(kind),
  detail: { readonly sdkErrorName?: string; readonly sdkErrorCode?: string } = {},
): Response {
  const error: GatewayErrorBody = {
    kind,
    message,
    ...(detail.sdkErrorName ? { sdkErrorName: detail.sdkErrorName } : {}),
    ...(detail.sdkErrorCode ? { sdkErrorCode: detail.sdkErrorCode } : {}),
  };
  return json({ ok: false, error }, status);
}
