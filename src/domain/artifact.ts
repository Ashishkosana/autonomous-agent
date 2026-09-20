import type { ArtifactId, IsoTimestamp } from './ids.js';
import type { Provenance, RunCorrelation } from './provenance.js';

export type ArtifactKind = 'file' | 'report' | 'code' | 'dataset' | 'log' | 'other';

/**
 * Where an artifact currently lives. Sandbox storage is ephemeral by design;
 * anything that must survive the run has to be promoted to persistent storage.
 */
export type ArtifactLocation =
  | { readonly storage: 'sandbox'; readonly path: string }
  | { readonly storage: 'persistent'; readonly key: string };

export interface ArtifactRef {
  readonly artifactId: ArtifactId;
  readonly kind: ArtifactKind;
  readonly location: ArtifactLocation;
  readonly correlation: RunCorrelation;
  readonly description: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly producedBy: Provenance;
  readonly createdAt: IsoTimestamp;
}
