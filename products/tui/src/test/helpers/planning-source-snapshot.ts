import { KnowledgeStore, type KnowledgeSourceSnapshot } from '@goodvibes-jev/engine/platform/platform/knowledge';

/**
 * Fresh persisted planning rows, opaque native row generations, and complete raw SQL values.
 * The full TUI also writes bootstrap/reconciled knowledge_schedules to this DB;
 * those independent scheduler rows are outside the saved planning contract.
 * Compare the complete returned set, not only the IDs expected by a fixture,
 * so adding, deleting or moving a planning record also fails the assertion.
 */
export async function readPlanningSourceSnapshots(dbPath: string, projectId: string): Promise<readonly KnowledgeSourceSnapshot[]> {
  const store = new KnowledgeStore({ dbPath });
  try {
    await store.init();
    return store.listSources(Number.MAX_SAFE_INTEGER)
      .filter(source => (source.metadata.projectId === projectId || source.metadata.knowledgeSpaceId === `project:${projectId}`)
        && (source.metadata.projectPlanning === true || source.connectorId === 'goodvibes-project-planning'))
      .sort((left, right) => left.id.localeCompare(right.id))
      // The snapshot's raw field retains every SQL column/value (including
      // unparsed JSON); generation separately identifies its native row revision.
      .map(source => store.getSourceSnapshot({ id: source.id }));
  } finally { await store.close(); }
}
