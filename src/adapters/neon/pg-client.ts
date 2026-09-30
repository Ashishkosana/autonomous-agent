import { Pool, type PoolClient } from 'pg';
import { MemoryStoreError } from '../../memory/errors.js';
import { mapDatabaseError, sslForConnectionString } from './database-url.js';

/**
 * The only file in `src/` that imports `pg`. Neon speaks the Postgres wire
 * protocol, so the same client reaches a Neon branch and a local Postgres.
 * The connection string stays on this object and is scrubbed from errors.
 */
export class PgClient {
  private readonly pool: Pool;
  private open = true;

  constructor(private readonly connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: sslForConnectionString(connectionString),
      max: 4,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
      application_name: 'autonomous-agent',
    });
    this.pool.on('error', () => undefined);
    this.pool.on('connect', (client) => {
      void client.query("SET statement_timeout = '60s'").catch(() => undefined);
    });
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.requireOpen();
    try {
      const result = await this.pool.query<Row>(text, [...values]);
      return result.rows;
    } catch (error: unknown) {
      throw mapDatabaseError(error, this.connectionString);
    }
  }

  /**
   * One transaction. `fn` throwing rolls the transaction back. Schema
   * migration uses this so a failed statement leaves the previous version.
   */
  async transaction<T>(fn: (query: PgClient['query']) => Promise<T>): Promise<T> {
    this.requireOpen();
    const client = await this.pool.connect();
    const bound = async <Row extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<readonly Row[]> => {
      const result = await client.query<Row>(text, [...values]);
      return result.rows;
    };
    try {
      await client.query('BEGIN');
      const value = await fn(bound);
      await client.query('COMMIT');
      return value;
    } catch (error: unknown) {
      await rollback(client);
      throw error instanceof MemoryStoreError
        ? error
        : mapDatabaseError(error, this.connectionString);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    await this.pool.end();
  }

  private requireOpen(): void {
    if (!this.open) {
      throw new MemoryStoreError('Neon memory database is closed', 'unavailable');
    }
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The connection is discarded by release when the transaction is aborted.
  }
}
