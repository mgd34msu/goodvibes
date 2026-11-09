import type { KnowledgeStore, ProjectPlanningService } from '../../platform/src/platform/knowledge/index.ts';
import { findCardNumberShapes } from '../../platform/src/platform/security/card-shapes.ts';

/**
 * Ordinary stale-revision cases need an ordinary comparison token. A native
 * SHA can accidentally look like card material; unmatched tokens deliberately
 * retain full privacy admission. Dedicated native-selection tests cover those
 * card-shaped fingerprints and must keep constructing them explicitly.
 */
export async function ordinaryPlanningRevision(store: KnowledgeStore, service: ProjectPlanningService, projectId: string) {
  let selected = await service.getState({ projectId });
  for (let attempt = 0; attempt < 32; attempt++) {
    if (!selected.source || !selected.revision) throw new Error('Planning fixture needs a persisted source revision');
    if (findCardNumberShapes(selected.revision.generation, 1).length === 0) return selected;
    // Only setup metadata changes; the planning state, action and actual
    // persisted-row fingerprint still go through their production paths.
    await store.upsertSource({ ...selected.source,
      metadata: { ...selected.source.metadata, ordinaryFixtureRevision: `fixture-${attempt}` },
    });
    selected = await service.getState({ projectId });
  }
  throw new Error('Could not construct an ordinary planning revision fixture');
}
