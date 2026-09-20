/**
 * Wire protocol between `HttpSandboxClient` (any host) and the gateway Worker
 * (`worker/src/`). It is a plain JSON RPC over the `SandboxClient` surface:
 *
 *   POST {gateway}/v1/sandboxes/{sandboxId}/{operation}
 *   Authorization: Bearer <token>
 *   body: GatewayRequest[operation]
 *   → 200 { ok: true, result }        | GatewayResult[operation]
 *   → 4xx/5xx { ok: false, error }    | GatewayErrorBody
 *
 * Keeping the protocol in `src/` (SDK-free) lets both ends import the same
 * types and lets the gateway's routing be unit tested in Node.
 */

import type {
  SandboxClientErrorKind,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxFileEntry,
  SandboxInfo,
  SandboxProcessRecord,
  SandboxStartProcessOptions,
} from './sandbox-client.js';

export const GATEWAY_API_PREFIX = '/v1/sandboxes';
export const GATEWAY_HEALTH_PATH = '/health';

/** Lowercase, DNS-safe ids; the SDK lowercases ids for preview URLs, so we require it up front. */
export const SANDBOX_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidSandboxId(value: string): boolean {
  return SANDBOX_ID_PATTERN.test(value);
}

export interface GatewayRequests {
  readonly exec: { readonly command: string; readonly options?: SandboxExecOptions };
  readonly startProcess: {
    readonly command: string;
    readonly options?: SandboxStartProcessOptions;
  };
  readonly listProcesses: Record<string, never>;
  readonly killProcess: { readonly processId: string; readonly signal?: string };
  readonly readFile: { readonly path: string };
  readonly writeFile: { readonly path: string; readonly content: string };
  readonly mkdir: { readonly path: string; readonly recursive: boolean };
  readonly deleteFile: { readonly path: string };
  readonly exists: { readonly path: string };
  readonly listFiles: { readonly path: string };
  readonly info: Record<string, never>;
  readonly destroy: Record<string, never>;
}

export interface GatewayResults {
  readonly exec: SandboxExecResult;
  readonly startProcess: SandboxProcessRecord;
  readonly listProcesses: readonly SandboxProcessRecord[];
  readonly killProcess: null;
  readonly readFile: { readonly content: string };
  readonly writeFile: null;
  readonly mkdir: null;
  readonly deleteFile: null;
  readonly exists: { readonly exists: boolean };
  readonly listFiles: readonly SandboxFileEntry[];
  readonly info: SandboxInfo;
  readonly destroy: null;
}

export type GatewayOperation = keyof GatewayRequests;

export const GATEWAY_OPERATIONS: readonly GatewayOperation[] = [
  'exec',
  'startProcess',
  'listProcesses',
  'killProcess',
  'readFile',
  'writeFile',
  'mkdir',
  'deleteFile',
  'exists',
  'listFiles',
  'info',
  'destroy',
];

export function isGatewayOperation(value: string): value is GatewayOperation {
  return (GATEWAY_OPERATIONS as readonly string[]).includes(value);
}

export interface GatewayErrorBody {
  readonly kind: SandboxClientErrorKind;
  readonly message: string;
  readonly sdkErrorName?: string;
  readonly sdkErrorCode?: string;
}

export type GatewayResponse<TOp extends GatewayOperation> =
  | { readonly ok: true; readonly result: GatewayResults[TOp] }
  | { readonly ok: false; readonly error: GatewayErrorBody };

export interface GatewayHealth {
  readonly ok: true;
  readonly service: 'agent-sandbox-gateway';
  readonly sdkVersion: string;
  /** Whether the bearer secret is configured. Never the secret itself. */
  readonly authConfigured: boolean;
}

/** HTTP status the gateway uses for each normalised error kind. */
export function statusForErrorKind(kind: SandboxClientErrorKind): number {
  switch (kind) {
    case 'file_not_found':
    case 'process_not_found':
      return 404;
    case 'permission_denied':
      return 403;
    case 'unauthorized':
      return 401;
    case 'invalid_request':
      return 400;
    case 'request_timeout':
      return 504;
    case 'container_unavailable':
      return 503;
    case 'protocol':
    case 'unknown':
      return 500;
  }
}

export function gatewayPath(sandboxId: string, operation: GatewayOperation): string {
  return `${GATEWAY_API_PREFIX}/${encodeURIComponent(sandboxId)}/${operation}`;
}

/** Parses `/v1/sandboxes/{id}/{op}`; returns `undefined` for anything else. */
export function parseGatewayPath(
  pathname: string,
): { readonly sandboxId: string; readonly operation: string } | undefined {
  if (!pathname.startsWith(`${GATEWAY_API_PREFIX}/`)) return undefined;
  const rest = pathname.slice(GATEWAY_API_PREFIX.length + 1).split('/');
  if (rest.length !== 2) return undefined;
  const [rawId, operation] = rest;
  if (!rawId || !operation) return undefined;
  let sandboxId: string;
  try {
    sandboxId = decodeURIComponent(rawId);
  } catch {
    return undefined;
  }
  return { sandboxId, operation };
}
