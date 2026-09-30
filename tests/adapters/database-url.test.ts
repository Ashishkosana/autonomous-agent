import { describe, expect, it } from 'vitest';
import {
  databasePassword,
  describeDatabaseTarget,
  mapDatabaseError,
  scrubConnectionString,
  sslForConnectionString,
} from '../../src/adapters/neon/database-url.js';

const url = 'postgres://agent:s3cret@ep-example.neon.tech:5432/agentdb';

describe('database url helpers', () => {
  it('describes the host and drops the password', () => {
    expect(describeDatabaseTarget(url)).toBe('neon @ agent@ep-example.neon.tech:5432/agentdb');
    expect(describeDatabaseTarget(url)).not.toContain('s3cret');
    expect(databasePassword(url)).toBe('s3cret');
  });

  it('scrubs the connection string and the password from an error', () => {
    const text = scrubConnectionString(`failed ${url} password s3cret`, url);
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('ep-example');
    expect(text).toContain('[REDACTED]');
  });

  it('uses TLS except for loopback', () => {
    expect(sslForConnectionString('postgres://agent@localhost/agent')).toBe(false);
    expect(sslForConnectionString('postgres://agent@127.0.0.1/agent')).toBe(false);
    expect(sslForConnectionString(url)).toEqual({ rejectUnauthorized: true });
  });

  it('maps a cross-run collision to conflict and hides the url', () => {
    const error = mapDatabaseError(
      Object.assign(new Error(`memory_conflict:mem-1 while using ${url}`), { code: 'P0001' }),
      url,
    );
    expect(error.kind).toBe('conflict');
    expect(error.recordId).toBe('mem-1');
    expect(error.message).not.toContain('s3cret');
  });
});
