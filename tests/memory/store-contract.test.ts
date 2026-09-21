import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryStore } from '../../src/memory/sqlite/sqlite-memory-store.js';
import { InMemoryMemoryStore } from '../support/in-memory-memory-store.js';
import { describeMemoryStoreContract } from '../support/memory-store-contract.js';

describeMemoryStoreContract('InMemoryMemoryStore (test double)', () => ({
  store: new InMemoryMemoryStore(),
  close: () => {},
}));

describeMemoryStoreContract('SqliteMemoryStore (:memory:)', () => {
  const store = SqliteMemoryStore.open({ path: ':memory:' });
  return { store, close: () => store.close() };
});

describeMemoryStoreContract('SqliteMemoryStore (file on disk)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-memory-contract-'));
  const store = SqliteMemoryStore.open({ path: join(dir, 'memory.sqlite') });
  return {
    store,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
