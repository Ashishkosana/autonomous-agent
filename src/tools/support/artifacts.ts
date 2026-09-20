import type { ArtifactKind, ArtifactRef } from '../../domain/artifact.js';
import { asArtifactId } from '../../domain/ids.js';
import type { ToolContext } from '../contracts.js';

/** An artifact reference for a file the action left in the sandbox workspace. */
export function sandboxFileArtifact(
  context: ToolContext,
  path: string,
  details: {
    readonly kind?: ArtifactKind;
    readonly sizeBytes?: number;
    readonly description: string;
  },
): ArtifactRef {
  return {
    artifactId: asArtifactId(context.ids.next('art')),
    kind: details.kind ?? 'file',
    location: { storage: 'sandbox', path },
    correlation: context.correlation,
    description: details.description,
    ...(details.sizeBytes !== undefined ? { sizeBytes: details.sizeBytes } : {}),
    producedBy: { actionIds: [context.actionId] },
    createdAt: context.clock.now(),
  };
}
