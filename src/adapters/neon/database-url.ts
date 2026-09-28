import { MemoryStoreError } from '../../memory/errors.js';

/** Removes a connection string and its password from text that might be logged. */
export function scrubConnectionString(text: string, connectionString: string): string {
  let out = text.split(connectionString).join('[REDACTED]');
  try {
    const url = new URL(connectionString);
    if (url.password.length > 0) {
      const decoded = safeDecode(url.password);
      out = out.split(url.password).join('[REDACTED]');
      if (decoded !== url.password) out = out.split(decoded).join('[REDACTED]');
    }
  } catch {
    // Not a URL. The raw string was already removed.
  }
  return out;
}

/** Host and database only. The password is never included. */
export function describeDatabaseTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, '') || 'database';
    const user = url.username.length > 0 ? `${safeDecode(url.username)}@` : '';
    const port = url.port.length > 0 ? `:${url.port}` : '';
    return `neon @ ${user}${url.hostname}${port}/${database}`;
  } catch {
    return 'neon (connection string set)';
  }
}

export function databasePassword(connectionString: string): string | undefined {
  try {
    const url = new URL(connectionString);
    if (url.password.length === 0) return undefined;
    const decoded = safeDecode(url.password);
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Local Postgres does not need TLS. Neon and every other host does. */
export function sslForConnectionString(
  connectionString: string,
): false | { readonly rejectUnauthorized: true } {
  try {
    const host = new URL(connectionString).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  } catch {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: true };
}

export function mapDatabaseError(
  error: unknown,
  connectionString: string,
  recordId?: string,
): MemoryStoreError {
  if (error instanceof MemoryStoreError) return error;
  const message = scrubConnectionString(errorText(error), connectionString);
  const code = errorCode(error);
  const conflict = /memory_conflict:(\S+)/.exec(message);
  const conflictId = conflict?.[1];
  if (conflictId) {
    return new MemoryStoreError(
      `Memory record ${conflictId} was written by another run and cannot be overwritten (id collision)`,
      'conflict',
      conflictId,
      { cause: error },
    );
  }
  if (code === '28P01' || code === '28000') {
    return new MemoryStoreError(
      `Neon authentication failed: ${message}`,
      'configuration',
      recordId,
      {
        cause: error,
      },
    );
  }
  return new MemoryStoreError(`Neon memory database error: ${message}`, 'unavailable', recordId, {
    cause: error,
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : '';
  }
  return '';
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
