import type { ArtifactRef } from '../domain/artifact.js';
import type { Clock } from '../domain/ids.js';
import type { AgentEventPayloads, EventCorrelation } from '../events/contracts.js';
import type { ExecutionEnvironment } from '../sandbox/execution-environment.js';
import { keyProblems } from './keys.js';
import type { PersistentStorage } from './persistent-storage.js';

/**
 * Promotes sandbox artifacts into persistent storage before the sandbox is
 * destroyed. Sandbox storage is ephemeral by design (`ArtifactLocation`);
 * this is the one place the two worlds meet, and it lives outside the
 * runtime loop: a composition root or the operator decides what to keep.
 *
 * Every artifact is attempted independently — one unreadable file must not
 * lose the others — and the caller receives a per-artifact result plus a
 * rewritten `ArtifactRef` whose location now points at storage.
 */
export interface ArchiveOptions {
  /** Key prefix, e.g. `artifacts`. Keys become `<prefix>/<runId>/<artifactId>/<file name>`. */
  readonly prefix: string;
  readonly clock: Clock;
  /** Wire to `session.emit('ARTIFACT_STORED', …)` so archiving is visible in the event stream. */
  readonly emit?: (
    payload: AgentEventPayloads['ARTIFACT_STORED'],
    correlation: EventCorrelation,
  ) => void;
}

export type ArchiveResult =
  | { readonly status: 'stored'; readonly source: ArtifactRef; readonly stored: ArtifactRef }
  | { readonly status: 'skipped'; readonly source: ArtifactRef; readonly reason: string }
  | { readonly status: 'failed'; readonly source: ArtifactRef; readonly reason: string };

export async function archiveArtifacts(
  environment: ExecutionEnvironment,
  artifacts: readonly ArtifactRef[],
  storage: PersistentStorage,
  options: ArchiveOptions,
): Promise<readonly ArchiveResult[]> {
  const results: ArchiveResult[] = [];
  for (const source of artifacts) {
    if (source.location.storage !== 'sandbox') {
      results.push({ status: 'skipped', source, reason: 'already in persistent storage' });
      continue;
    }
    const sandboxPath = source.location.path;
    const key = archiveKey(options.prefix, source, sandboxPath);
    try {
      const content = await environment.readFile(sandboxPath);
      const bytes = new TextEncoder().encode(content);
      await storage.putObject(key, bytes, {
        ...(source.contentType !== undefined ? { contentType: source.contentType } : {}),
        custom: {
          artifactId: source.artifactId,
          runId: source.correlation.runId,
          sandboxPath,
          kind: source.kind,
          description: source.description,
        },
      });
      const stored: ArtifactRef = {
        ...source,
        location: { storage: 'persistent', key },
        sizeBytes: bytes.byteLength,
        createdAt: options.clock.now(),
      };
      options.emit?.(
        {
          artifactId: source.artifactId,
          sandboxPath,
          storageProvider: storage.provider,
          key,
          sizeBytes: bytes.byteLength,
        },
        correlationOf(source),
      );
      results.push({ status: 'stored', source, stored });
    } catch (error: unknown) {
      results.push({
        status: 'failed',
        source,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function correlationOf(artifact: ArtifactRef): EventCorrelation {
  const ids = artifact.producedBy;
  return {
    ...(artifact.correlation.taskId ? { taskId: artifact.correlation.taskId } : {}),
    ...(ids.actionIds?.[0] ? { actionId: ids.actionIds[0] } : {}),
    ...(ids.planIds?.[0] ? { planId: ids.planIds[0] } : {}),
  };
}

/** `<prefix>/<runId>/<artifactId>/<file name>`, each segment coerced into the key grammar. */
export function archiveKey(prefix: string, artifact: ArtifactRef, sandboxPath: string): string {
  const fileName = sandboxPath.split('/').filter(Boolean).at(-1) ?? 'artifact';
  return [prefix, artifact.correlation.runId, artifact.artifactId, fileName]
    .map(safeSegment)
    .join('/');
}

function safeSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '');
  const segment = cleaned.length > 0 ? cleaned : 'x';
  return keyProblems(segment).length === 0 ? segment : 'x';
}
