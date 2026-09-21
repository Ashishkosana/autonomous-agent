import type { IdGenerator } from './ids.js';

/**
 * Production id generator: `<prefix>-<20 hex chars>` from 80 bits of
 * cryptographic randomness (Web Crypto, so it works in Node and in Workers).
 *
 * Why not a counter: memory records outlive the process that wrote them
 * (Phase 6). Two runs in two processes that both count `mem-1, mem-2, …`
 * would silently overwrite each other's records in a shared store — E-007
 * caught exactly that with the deterministic test generator. Ids that reach
 * durable storage must be unique across runs, machines and time, without
 * coordination.
 *
 * The readable prefix is kept because ids are shown to models and humans
 * (`[mem-…] (lesson) …` in prompts, correlation fields in events).
 */
export class UniqueIdGenerator implements IdGenerator {
  constructor(private readonly randomBytes = 10) {}

  next(prefix: string): string {
    const bytes = new Uint8Array(this.randomBytes);
    globalThis.crypto.getRandomValues(bytes);
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return `${prefix}-${hex}`;
  }
}
