/**
 * Environment variable names for reaching a deployed gateway Worker. Values
 * are secrets and are only ever read from the process environment: never
 * from source, never written to events, memory or logs.
 */
export const GATEWAY_URL_ENV = 'AGENT_SANDBOX_GATEWAY_URL';
export const GATEWAY_TOKEN_ENV = 'AGENT_SANDBOX_GATEWAY_TOKEN';

export interface CloudflareGatewayConfig {
  readonly gatewayUrl: string;
  readonly token: string;
}

export type GatewayConfigResult =
  | { readonly configured: true; readonly config: CloudflareGatewayConfig }
  | { readonly configured: false; readonly missing: readonly string[] };

/** Reads gateway settings from an environment map; reports which names are missing, not values. */
export function readGatewayConfig(
  env: Readonly<Record<string, string | undefined>>,
): GatewayConfigResult {
  const gatewayUrl = env[GATEWAY_URL_ENV]?.trim();
  const token = env[GATEWAY_TOKEN_ENV]?.trim();
  const missing: string[] = [];
  if (!gatewayUrl) missing.push(GATEWAY_URL_ENV);
  if (!token) missing.push(GATEWAY_TOKEN_ENV);
  if (missing.length > 0 || !gatewayUrl || !token) return { configured: false, missing };
  return { configured: true, config: { gatewayUrl, token } };
}
