import { randomUUID } from 'node:crypto';
import {
  knowledgeSpaceMetadata,
  projectPlanningCanonicalUri,
  resolveProjectPlanningSpace,
  type KnowledgeSourceRecord,
  type ProjectPlanningLanguageArtifact,
  type ProjectPlanningState,
} from '../../platform/src/platform/knowledge/index.js';
import type { KnowledgeStore } from '../../platform/src/platform/knowledge/store.js';

/**
 * Writes a planning record the way the retired planning interview saved it, so
 * tests of the read-only history views have something to read. Nothing in the
 * product writes these records any more.
 */
export async function seedHistoricalPlanningState(
  store: KnowledgeStore,
  projectId: string,
  state: Partial<ProjectPlanningState> & { readonly goal: string },
): Promise<{ readonly state: ProjectPlanningState; readonly source: KnowledgeSourceRecord }> {
  const space = resolveProjectPlanningSpace({ projectId });
  const now = Date.now();
  const saved: ProjectPlanningState = {
    id: 'current', knownContext: [], openQuestions: [], answeredQuestions: [], decisions: [], assumptions: [],
    constraints: [], risks: [], tasks: [], dependencies: [], verificationGates: [], agentAssignments: [],
    readiness: 'not-ready', executionApproved: false, createdAt: now, updatedAt: now,
    ...state,
    projectId: space.projectId,
    knowledgeSpaceId: space.knowledgeSpaceId,
  };
  return { state: saved, source: await writeRecord(store, space, 'state', saved.id, `Planning: ${saved.goal}`, saved) };
}

export async function seedHistoricalPlanningLanguage(
  store: KnowledgeStore,
  projectId: string,
  language: Pick<ProjectPlanningLanguageArtifact, 'terms' | 'ambiguities'>,
): Promise<KnowledgeSourceRecord> {
  const space = resolveProjectPlanningSpace({ projectId });
  const saved: ProjectPlanningLanguageArtifact = { ...language, ...space, updatedAt: Date.now() };
  return writeRecord(store, space, 'language', 'current', 'Project Language', saved);
}

async function writeRecord(
  store: KnowledgeStore,
  space: { readonly projectId: string; readonly knowledgeSpaceId: string },
  kind: 'state' | 'language',
  id: string,
  title: string,
  value: object,
): Promise<KnowledgeSourceRecord> {
  await store.init();
  return store.upsertSource({
    id: `project-planning-${kind}-${randomUUID()}`,
    connectorId: 'goodvibes-project-planning',
    sourceType: 'dataset',
    title,
    canonicalUri: projectPlanningCanonicalUri(space.knowledgeSpaceId, kind, id),
    tags: ['project-planning', `project-planning:${kind}`],
    status: 'indexed',
    metadata: knowledgeSpaceMetadata(space.knowledgeSpaceId, {
      projectPlanning: true,
      planningArtifactKind: kind,
      planningArtifactId: id,
      projectId: space.projectId,
      value: JSON.parse(JSON.stringify(value)) as Record<string, unknown>,
    }),
  });
}
