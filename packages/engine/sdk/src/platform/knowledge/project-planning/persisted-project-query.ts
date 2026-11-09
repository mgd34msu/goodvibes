/** Fixed metadata-only project selector; no writable handle escapes to callers. */
import type { SqlDatabase } from '../../state/sqlite-store.js';
import { KNOWLEDGE_SCHEMA_VERSION } from '../store-schema-version.js';
const projectTables = ['work_ledgers', 'native_conversation_captures', 'native_work_executions', 'native_work_execution_intents', 'native_work_execution_settlements', 'native_ci_continuations'] as const;
export class PlanningProjectInspectionError extends Error {
  override readonly name = 'PlanningProjectInspectionError';
  constructor() { super('Existing project storage cannot be inspected safely; preserve it before repairing or selecting another store.'); }
}
export function queryPersistedPlanningProjects(database: Pick<SqlDatabase, 'exec'>): readonly string[] {
  const version = database.exec('PRAGMA user_version')[0]?.values[0]?.[0];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0 || version > KNOWLEDGE_SCHEMA_VERSION) throw new PlanningProjectInspectionError();
  const rows = database.exec("SELECT name,type FROM sqlite_master WHERE name IN ('knowledge_sources','work_ledgers','native_conversation_captures','native_work_executions','native_work_execution_intents','native_work_execution_settlements','native_ci_continuations')")[0]?.values ?? [];
  const tables = new Set<string>(); for (const row of rows) { if (typeof row[0] !== 'string' || row[1] !== 'table') throw new PlanningProjectInspectionError(); tables.add(row[0]); }
  if (!tables.has('knowledge_sources')) throw new PlanningProjectInspectionError();
  const sourceColumns = database.exec('PRAGMA table_info(knowledge_sources)')[0]?.values ?? [];
  if (!['connector_id', 'metadata', 'canonical_uri'].every(name => sourceColumns.some(row => row[1] === name && String(row[2]).toUpperCase() === 'TEXT'))) throw new PlanningProjectInspectionError();
  const ids = new Set<string>();
  const add = (value: unknown) => { if (typeof value !== 'string' || !value) throw new PlanningProjectInspectionError(); ids.add(value); };
  if ((database.exec("SELECT COUNT(*) FROM knowledge_sources WHERE connector_id = 'goodvibes-project-planning' AND NOT json_valid(metadata)")[0]?.values[0]?.[0] ?? 0) !== 0) throw new PlanningProjectInspectionError();
  const sourceIds = database.exec(`SELECT DISTINCT
    CASE WHEN json_type(metadata, '$.projectId') = 'text' THEN json_extract(metadata, '$.projectId') END,
    COALESCE(json_extract(metadata, '$.knowledgeSpaceId'), json_extract(metadata, '$.spaceId'), json_extract(metadata, '$.namespace')),
    canonical_uri FROM knowledge_sources WHERE connector_id = 'goodvibes-project-planning'`)[0]?.values ?? [];
  for (const row of sourceIds) {
    const project = typeof row[0] === 'string' ? row[0] : null;
    const space = typeof row[1] === 'string' && row[1].startsWith('project:') ? row[1].slice(8) : null;
    if (project !== null && space !== null && project !== space) throw new PlanningProjectInspectionError();
    if (project !== null || space !== null) { add(project ?? space); continue; }
    if (typeof row[2] !== 'string') throw new PlanningProjectInspectionError();
    try {
      const uri = new URL(row[2]), selectedSpace = decodeURIComponent(uri.pathname.split('/')[1] ?? '');
      if (uri.protocol !== 'goodvibes:' || uri.host !== 'planning' || !selectedSpace.startsWith('project:')) throw new PlanningProjectInspectionError();
      add(selectedSpace.slice(8));
    } catch { throw new PlanningProjectInspectionError(); }
  }
  for (const table of projectTables) {
    if (!tables.has(table)) continue;
    const columns = database.exec(`PRAGMA table_info(${table})`)[0]?.values ?? [];
    if (!columns.some(row => row[1] === 'project_id' && String(row[2]).toUpperCase() === 'TEXT')) throw new PlanningProjectInspectionError();
    for (const row of database.exec(`SELECT DISTINCT project_id FROM ${table}`)[0]?.values ?? []) add(row[0]);
  }
  return Object.freeze([...ids].sort());
}
