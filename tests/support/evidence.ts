import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Evidence from real-infrastructure runs is written OUTSIDE the repository —
 * to AGENT_SANDBOX_EVIDENCE_DIR or `<os tmp>/agent-sandbox-evidence` — so it
 * can be reviewed and summarised into docs without committing raw dumps.
 */
export function evidenceDir(): string {
  return process.env['AGENT_SANDBOX_EVIDENCE_DIR'] ?? join(tmpdir(), 'agent-sandbox-evidence');
}

export function recordEvidence(name: string, data: unknown): string {
  const dir = evidenceDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({ recordedAt: new Date().toISOString(), ...asObject(data) }, null, 2),
  );
  console.info(`[evidence] ${name} → ${file}`);
  return file;
}

export function uniqueId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${random}`.toLowerCase();
}

function asObject(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : { value: data };
}
