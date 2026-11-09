import type { KnowledgeStore } from '../../platform/src/platform/knowledge/store.js';

/** An explicit saved old-format label exercises structural-reference privacy.
 * Fresh producers allocate opaque labels; this fixture must not depend on a
 * new UUID or an incidental hash happening to contain a card-number shape. */
export const protectedHistoricalFactId = 'sem-fact-4111111111111111';

export async function seedProtectedHistoricalFact(store: KnowledgeStore, spaceId: string, sourceId: string, subjectId: string) {
  return store.upsertNode({ id: protectedHistoricalFactId, kind: 'fact', slug: 'historical-hdmi-ports',
    title: 'HDMI ports', summary: 'AC-7 has four HDMI ports.', sourceId, status: 'draft',
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'specification', value: 'four hdmi ports',
      subjectIds: [subjectId], sourceIds: [sourceId] } });
}
