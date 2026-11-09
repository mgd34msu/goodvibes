/** Private durable dependency bookkeeping. The model sees neither SQL versions
 * nor copies of source bodies. A receipt reference alone grants no reuse. */
import type { SqlDatabase } from '../state/sqlite-store.js';
import { KnowledgeRowRevisionError } from './store-row-revisions.js';
import { knowledgeRowGenerationFromRows } from './store-row-revisions.js';
import { knowledgeNodeContentGenerationFromRows } from './store-node-content-revisions.js';

export interface KnowledgeActivationDependencies {
  readonly version: 1;
  readonly nodeGeneration: string | null;
  readonly evidence: readonly { readonly sourceId: string; readonly sourceGeneration: string | null;
    readonly extractionId: string | null; readonly extractionGeneration: string | null }[];
  readonly subjects: readonly { readonly nodeId: string; readonly generation: string | null }[];
  readonly observation: string | null;
}
export interface KnowledgeActivationCacheRow {
  readonly reference: string;
  readonly receipt: unknown;
  readonly dependencies: KnowledgeActivationDependencies;
}
export const activationNodeGenerationSql = 'SELECT gv_revision,gv_content_revision FROM knowledge_nodes WHERE id = ? LIMIT 1';
export const activationSourceGenerationSql = 'SELECT gv_revision FROM knowledge_sources WHERE id = ? LIMIT 1';
export const activationExtractionGenerationSql = 'SELECT id,gv_revision FROM knowledge_extractions WHERE source_id = ? LIMIT 2';
export const activationCacheRowSql = 'SELECT receipt_reference,receipt_json,dependencies_json FROM knowledge_node_activation_dependencies WHERE node_id = ? LIMIT 1';

/** Internal code supplies the actual native SQL image, never a model callback.
 * The public store method accepts only closed source/node selectors. */
export function readKnowledgeActivationDependencies(db: Pick<SqlDatabase, 'exec'>, nodeId: string,
  sourceIds: readonly string[], subjectIds: readonly string[], observation: string | null): KnowledgeActivationDependencies {
  return { version: 1, nodeGeneration: knowledgeNodeContentGenerationFromRows(db.exec(activationNodeGenerationSql, [nodeId])),
    evidence: sourceIds.map(sourceId => {
      const sourceGeneration = knowledgeRowGenerationFromRows(db.exec(activationSourceGenerationSql, [sourceId]));
      const rows = db.exec(activationExtractionGenerationSql, [sourceId]);
      if ((rows[0]?.values.length ?? 0) > 1) throw new KnowledgeRowRevisionError();
      const extractionId: unknown = rows[0]?.values[0]?.[rows[0].columns.indexOf('id')];
      if (extractionId !== undefined && typeof extractionId !== 'string') throw new KnowledgeRowRevisionError();
      return { sourceId, sourceGeneration, extractionId: extractionId ?? null,
        extractionGeneration: knowledgeRowGenerationFromRows(rows) };
    }), subjects: subjectIds.map(id => ({ nodeId: id,
      generation: knowledgeNodeContentGenerationFromRows(db.exec(activationNodeGenerationSql, [id])) })), observation };
}
export const knowledgeNodeActivationCacheSql = `CREATE TABLE knowledge_node_activation_dependencies (
  node_id TEXT NOT NULL PRIMARY KEY,
  receipt_reference TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL
)`;
export const knowledgeNodeActivationCacheDeleteSql = `CREATE TRIGGER knowledge_node_activation_dependencies_delete AFTER DELETE ON knowledge_nodes BEGIN
  DELETE FROM knowledge_node_activation_dependencies WHERE node_id = OLD.id;
END`;

export function createKnowledgeNodeActivationCache(db: Pick<SqlDatabase, 'run' | 'exec'>): void {
  const table = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_node_activation_dependencies'")[0]?.values[0]?.[0];
  if (table === undefined) db.run(knowledgeNodeActivationCacheSql);
  else if (table !== knowledgeNodeActivationCacheSql) throw new KnowledgeRowRevisionError();
  const trigger = db.exec("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='knowledge_node_activation_dependencies_delete'")[0]?.values[0]?.[0];
  if (trigger === undefined) db.run(knowledgeNodeActivationCacheDeleteSql);
  else if (trigger !== knowledgeNodeActivationCacheDeleteSql) throw new KnowledgeRowRevisionError();
  validateKnowledgeNodeActivationCache(db);
}
export function validateKnowledgeNodeActivationCache(db: Pick<SqlDatabase, 'exec'>): void {
  const rows = db.exec("SELECT name,type,sql FROM sqlite_master WHERE name IN ('knowledge_node_activation_dependencies','knowledge_node_activation_dependencies_delete')")[0]?.values ?? [];
  if (rows.length !== 2 || !rows.some(row => row[0] === 'knowledge_node_activation_dependencies' && row[1] === 'table' && row[2] === knowledgeNodeActivationCacheSql)
    || !rows.some(row => row[0] === 'knowledge_node_activation_dependencies_delete' && row[1] === 'trigger' && row[2] === knowledgeNodeActivationCacheDeleteSql)) throw new KnowledgeRowRevisionError();
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const opaqueReference = (value: unknown): value is string => typeof value === 'string' && /^[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/.test(value);
const generation = (value: unknown, prefix: 'kr' | 'kc'): value is string => typeof value === 'string' && (prefix === 'kr' ? /^kr-[0-9a-f]{32}$/ : /^kc-[0-9a-f]{32}$/).test(value);
const nullableGeneration = (value: unknown, prefix: 'kr' | 'kc'): value is string | null => value === null || generation(value, prefix);
const nullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';
export function parseKnowledgeActivationCacheRow(rows: ReturnType<SqlDatabase['exec']>): KnowledgeActivationCacheRow | null {
  const result = rows[0], cells = result?.values[0];
  if (!result || !cells) return null;
  const field = (name: string): unknown => cells[result.columns.indexOf(name)];
  const reference = field('receipt_reference'), receiptJson = field('receipt_json'), dependenciesJson = field('dependencies_json');
  if (!opaqueReference(reference) || typeof receiptJson !== 'string' || typeof dependenciesJson !== 'string') throw new KnowledgeRowRevisionError();
  let receipt: unknown, dependencies: unknown;
  try { receipt = JSON.parse(receiptJson); dependencies = JSON.parse(dependenciesJson); } catch { throw new KnowledgeRowRevisionError(); }
  if (!object(receipt) || receipt.dependencyVersion !== 1 || receipt.dependencyReference !== reference || receipt.outcome !== 'accepted'
    || !object(dependencies) || Object.keys(dependencies).length !== 5 || dependencies.version !== 1
    || !generation(dependencies.nodeGeneration, 'kc') || (dependencies.observation !== null && !opaqueReference(dependencies.observation))
    || !Array.isArray(dependencies.evidence) || !Array.isArray(dependencies.subjects)
    || dependencies.evidence.some((entry: unknown) => !object(entry) || Object.keys(entry).length !== 4 || typeof entry.sourceId !== 'string'
      || !nullableGeneration(entry.sourceGeneration, 'kr') || !nullableText(entry.extractionId) || !nullableGeneration(entry.extractionGeneration, 'kr')
      || (entry.extractionId === null) !== (entry.extractionGeneration === null))
    || dependencies.subjects.some((entry: unknown) => !object(entry) || Object.keys(entry).length !== 2 || typeof entry.nodeId !== 'string' || !nullableGeneration(entry.generation, 'kc'))) throw new KnowledgeRowRevisionError();
  return { reference, receipt, dependencies: dependencies as unknown as KnowledgeActivationDependencies };
}

/** Only the actual native pass writer calls this inside its original SQL
 * publication. Updating this table never rotates a subject's content version. */
export function writeKnowledgeActivationCache(db: Pick<SqlDatabase, 'run'>, nodeId: string, reference: string,
  receipt: unknown, dependencies: KnowledgeActivationDependencies): void {
  db.run(`INSERT INTO knowledge_node_activation_dependencies(node_id,receipt_reference,receipt_json,dependencies_json) VALUES(?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET receipt_reference=excluded.receipt_reference,receipt_json=excluded.receipt_json,dependencies_json=excluded.dependencies_json`,
  [nodeId, reference, JSON.stringify(receipt), JSON.stringify(dependencies)]);
}
