import { describe, expect, it } from 'vitest';
import { UniqueIdGenerator } from '../../src/domain/unique-ids.js';

describe('UniqueIdGenerator', () => {
  it('keeps the readable prefix and adds 20 hex characters of randomness', () => {
    const id = new UniqueIdGenerator().next('mem');
    expect(id).toMatch(/^mem-[0-9a-f]{20}$/);
  });

  it('two independent generators (as in two processes) never collide across many ids', () => {
    const a = new UniqueIdGenerator();
    const b = new UniqueIdGenerator();
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) {
      seen.add(a.next('mem'));
      seen.add(b.next('mem'));
    }
    expect(seen.size).toBe(40_000);
  });
});
