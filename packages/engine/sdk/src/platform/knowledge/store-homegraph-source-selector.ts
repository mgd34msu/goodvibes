import { knowledgeRawRepresentation } from './store-record-representation.js';
/** Native source identity uses saved role/locator facts, independently of the
 * chosen opaque label or URL. Earlier rows remain unchanged and inspectable. */
import type { SqlDatabase } from '../state/sqlite-store.js';
import type { KnowledgeSourceRecord } from './types.js';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { getKnowledgeSpaceId } from './spaces.js';
import { homeGraphIdentitySpace, HomeGraphIdentityHeldError as Held } from './store-homegraph-node-selector.js';
export type HomeGraphSourceRole = 'snapshot' | 'documentation-candidate' | 'url' | 'note' | 'artifact' | 'generated-page';
export interface HomeGraphSourceSelector {
  readonly spaceId: string;
  readonly role: HomeGraphSourceRole;
  readonly locator?: 'uri' | 'artifact' | undefined;
  readonly value?: string | undefined;
  /** Absent means a new capture event, not a replay selected by wall clock. */
  readonly capturedAt?: number | undefined;
  readonly projectionKind?: 'device-passport' | 'room-page' | 'packet' | undefined;
  readonly keys?: readonly string[] | undefined;
  readonly sharingProfile?: string | undefined;
}
const roles = new Set(['snapshot', 'documentation-candidate', 'url', 'note', 'artifact', 'generated-page']);
export function homeGraphSourceSelector(input: HomeGraphSourceSelector): HomeGraphSourceSelector {
  const value = captureStrictJudgmentJson(input);
  if (typeof value.spaceId !== 'string' || !value.spaceId.trim() || !roles.has(value.role)) throw new Held('malformed');
  const text = (item: unknown): item is string => typeof item === 'string' && !!item.trim();
  if (value.role === 'snapshot') {
    if (value.capturedAt !== undefined && (!Number.isSafeInteger(value.capturedAt) || !Number.isFinite(new Date(value.capturedAt).getTime()))) throw new Held('malformed');
  } else if (value.role === 'generated-page') {
    if (!['device-passport','room-page','packet'].includes(value.projectionKind!) || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 4
      || value.keys.some(key => typeof key !== 'string' || !key && value.projectionKind !== 'room-page') || value.projectionKind === 'packet' && !text(value.sharingProfile)) throw new Held('malformed');
  } else if (!['uri','artifact'].includes(value.locator!) || !text(value.value)
    || ['url','documentation-candidate'].includes(value.role) && value.locator !== 'uri' || value.role === 'note' && value.locator !== 'artifact') throw new Held('malformed');
  return Object.freeze({ role: value.role, spaceId: homeGraphIdentitySpace(value.spaceId),
    ...(value.role === 'snapshot' ? value.capturedAt === undefined ? {} : { capturedAt: value.capturedAt }
      : value.role === 'generated-page' ? { projectionKind: value.projectionKind, keys: Object.freeze([...new Set(value.keys!)].sort()), ...(value.projectionKind === 'packet' ? { sharingProfile: value.sharingProfile } : {}) }
      : { locator: value.locator, value: value.value }) });
}
function metadataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Held('malformed'); return value as Record<string, unknown>;
}
export function homeGraphSourceMatches(source: Pick<KnowledgeSourceRecord,'connectorId'|'metadata'|'sourceUri'|'canonicalUri'|'artifactId'|'lastCrawledAt'>, input: HomeGraphSourceSelector): boolean {
  const selector = homeGraphSourceSelector(input), metadata = knowledgeRawRepresentation(source.metadata);
  if (source.connectorId !== 'homeassistant' || metadata.homeGraphSourceKind !== selector.role || homeGraphIdentitySpace(getKnowledgeSpaceId(source)) !== selector.spaceId) return false;
  let match = false;
  if (selector.role === 'snapshot') match = selector.capturedAt !== undefined && metadata.capturedAt === selector.capturedAt && source.lastCrawledAt === selector.capturedAt;
  else if (selector.role === 'generated-page') {
    if (metadata.projectionKind !== selector.projectionKind) return false;
    const key = selector.projectionKind === 'device-passport' ? metadata.deviceId : selector.projectionKind === 'room-page' ? metadata.areaId ?? '' : metadata.packetKind;
    match = typeof key === 'string' && !!selector.keys?.includes(key) && (selector.projectionKind !== 'packet' || metadata.sharingProfile === selector.sharingProfile);
  } else match = selector.locator === 'uri' ? source.sourceUri === selector.value : source.artifactId === selector.value;
  if (!match) return false;
  const version = metadata.homeGraphSourceIdentityVersion;
  if (version !== undefined && version !== 1) throw new Held('unsupported-format');
  if (version === 1 && (metadata.homeGraphIdentitySpace !== selector.spaceId || selector.locator && metadata.homeGraphSourceLocator !== selector.locator)) throw new Held('malformed');
  return true;
}
const role = "json_extract(metadata, '$.homeGraphSourceKind')", projection = "json_extract(metadata, '$.projectionKind')";
const base = "connector_id = 'homeassistant' AND json_valid(metadata)";
const pageKey = `CASE ${projection} WHEN 'device-passport' THEN json_extract(metadata, '$.deviceId') WHEN 'room-page' THEN COALESCE(json_extract(metadata, '$.areaId'), '') WHEN 'packet' THEN json_extract(metadata, '$.packetKind') END`;
const profile = `CASE WHEN ${role} = 'generated-page' AND ${projection} = 'packet' THEN json_extract(metadata, '$.sharingProfile') ELSE '' END`;
const identityKind = `CASE ${role} WHEN 'snapshot' THEN CASE WHEN json_type(metadata, '$.capturedAt') = 'integer' THEN 'supplied-time' END WHEN 'generated-page' THEN ${projection} ELSE json_extract(metadata, '$.homeGraphSourceLocator') END`;
const identityValue = `CASE ${role} WHEN 'snapshot' THEN CAST(json_extract(metadata, '$.capturedAt') AS TEXT) WHEN 'generated-page' THEN ${pageKey} ELSE CASE json_extract(metadata, '$.homeGraphSourceLocator') WHEN 'uri' THEN source_uri WHEN 'artifact' THEN artifact_id END END`;
export const homeGraphSourceIdentityIndexes = Object.freeze([
  Object.freeze({ name: 'idx_knowledge_sources_homegraph_uri', sql: `CREATE INDEX idx_knowledge_sources_homegraph_uri ON knowledge_sources (connector_id, source_uri) WHERE source_uri IS NOT NULL` }),
  Object.freeze({ name: 'idx_knowledge_sources_homegraph_capture', sql: `CREATE INDEX idx_knowledge_sources_homegraph_capture ON knowledge_sources (last_crawled_at) WHERE ${base} AND ${role} = 'snapshot'` }),
  Object.freeze({ name: 'idx_knowledge_sources_homegraph_page', sql: `CREATE INDEX idx_knowledge_sources_homegraph_page ON knowledge_sources (${projection}, ${pageKey}, ${profile}) WHERE ${base} AND ${role} = 'generated-page'` }),
  Object.freeze({ name: 'idx_knowledge_sources_homegraph_identity_v1', sql: `CREATE UNIQUE INDEX idx_knowledge_sources_homegraph_identity_v1 ON knowledge_sources (json_extract(metadata, '$.homeGraphIdentitySpace'), ${role}, ${identityKind}, ${identityValue}, ${profile}) WHERE ${base} AND json_extract(metadata, '$.homeGraphSourceIdentityVersion') = 1` }),
]);
export function homeGraphSourceCandidateQuery(input: HomeGraphSourceSelector): { readonly sql: string; readonly params: (string | number)[] } {
  const selector = homeGraphSourceSelector(input), prefix = `SELECT * FROM knowledge_sources WHERE ${base} AND ${role} = '${selector.role}'`, params: (string | number)[] = [];
  // role was checked against a fixed six-value vocabulary. Literal partial
  // predicates let SQLite choose the actual role index without bound-value inference.
  if (selector.role === 'snapshot') {
    if (selector.capturedAt === undefined) return { sql: prefix + ' AND 0', params };
    return { sql: prefix + ' AND last_crawled_at IN (?, ?)', params: [...params, selector.capturedAt, new Date(selector.capturedAt).toISOString()] };
  }
  if (selector.role === 'generated-page') return { sql: prefix + ` AND ${projection} = ? AND ${pageKey} IN (${selector.keys!.map(() => '?').join(',')}) AND ${profile} = ?`, params: [...params, selector.projectionKind!, ...selector.keys!, selector.projectionKind === 'packet' ? selector.sharingProfile! : ''] };
  return { sql: prefix + (selector.locator === 'uri' ? ' AND source_uri = ?' : ' AND artifact_id = ?'), params: [...params, selector.value!] };
}
export function createHomeGraphSourceIdentityIndexes(db: Pick<SqlDatabase,'run'|'exec'>): void {
  for (const index of homeGraphSourceIdentityIndexes) { const row = db.exec('SELECT type,sql FROM sqlite_master WHERE name = ?', [index.name])[0]?.values[0]; if (!row) db.run(index.sql); else if (row[0] !== 'index' || row[1] !== index.sql) throw new Held('malformed'); }
  validateHomeGraphSourceIdentityIndexes(db);
}
export function validateHomeGraphSourceIdentityIndexes(db: Pick<SqlDatabase,'exec'>): void {
  for (const index of homeGraphSourceIdentityIndexes) { const row = db.exec('SELECT type,sql FROM sqlite_master WHERE name = ?', [index.name])[0]?.values[0]; if (!row || row[0] !== 'index' || row[1] !== index.sql) throw new Held('malformed'); }
}
export function homeGraphSourceRecordSelector(record: Pick<KnowledgeSourceRecord,'metadata'|'sourceUri'|'artifactId'|'lastCrawledAt'>): HomeGraphSourceSelector {
  const metadata = knowledgeRawRepresentation(record.metadata), common = { spaceId: getKnowledgeSpaceId(record), role: metadata.homeGraphSourceKind as HomeGraphSourceRole };
  if (common.role === 'snapshot') return homeGraphSourceSelector({ ...common, ...(typeof metadata.capturedAt === 'number' ? { capturedAt: metadata.capturedAt } : {}) });
  if (common.role === 'generated-page') return homeGraphSourceSelector({ ...common, projectionKind: metadata.projectionKind as HomeGraphSourceSelector['projectionKind'], keys: [metadata.projectionKind === 'device-passport' ? metadata.deviceId as string : metadata.projectionKind === 'room-page' ? (metadata.areaId ?? '') as string : metadata.packetKind as string], ...(metadata.projectionKind === 'packet' ? { sharingProfile: metadata.sharingProfile as string } : {}) });
  return homeGraphSourceSelector({ ...common, locator: metadata.homeGraphSourceLocator as 'uri'|'artifact', value: metadata.homeGraphSourceLocator === 'uri' ? record.sourceUri : record.artifactId });
}
/** Actual serial SQL prefix check. Tuple metadata is data, never execution authority. */
export function assertHomeGraphSourceIdentityWrite(db: Pick<SqlDatabase,'exec'>, record: Pick<KnowledgeSourceRecord,'id'|'connectorId'|'metadata'|'sourceUri'|'canonicalUri'|'artifactId'|'lastCrawledAt'>): void {
  const metadata = knowledgeRawRepresentation(record.metadata);
  if (metadata.homeGraphSourceIdentityVersion === undefined) return;
  if (metadata.homeGraphSourceIdentityVersion !== 1 || record.connectorId !== 'homeassistant') throw new Held('malformed');
  const selector = homeGraphSourceRecordSelector(record);
  if (metadata.homeGraphIdentitySpace !== selector.spaceId || selector.role === 'snapshot' && selector.capturedAt === undefined && (typeof record.lastCrawledAt !== 'number' || !Number.isFinite(record.lastCrawledAt) || metadata.capturedAt !== new Date(record.lastCrawledAt).toISOString())) throw new Held('malformed');
  const current = db.exec('SELECT * FROM knowledge_sources WHERE id = ? LIMIT 1', [record.id])[0];
  const from = (columns: string[], values: unknown[]) => {
    const at = (name: string) => values[columns.indexOf(name)];
    let decoded: unknown; try { decoded = JSON.parse(String(at('metadata'))); } catch { throw new Held('malformed'); }
    const metadata = metadataRecord(decoded);
    return { id: String(at('id')), connectorId: String(at('connector_id')), metadata, sourceUri: at('source_uri') as string | undefined, canonicalUri: at('canonical_uri') as string | undefined,
      artifactId: at('artifact_id') as string | undefined, lastCrawledAt: typeof at('last_crawled_at') === 'number' ? at('last_crawled_at') as number : Date.parse(String(at('last_crawled_at'))) };
  };
  if (current?.values[0]) {
    const original = from(current.columns, current.values[0]);
    if (selector.role === 'snapshot' && selector.capturedAt === undefined ? original.connectorId !== 'homeassistant' || homeGraphIdentitySpace(getKnowledgeSpaceId(original)) !== selector.spaceId || original.metadata.homeGraphSourceKind !== 'snapshot' || original.metadata.capturedAt !== metadata.capturedAt || original.metadata.homeGraphSourceIdentityVersion !== undefined && original.metadata.homeGraphSourceIdentityVersion !== 1 : !homeGraphSourceMatches(original, selector)) throw new Held('stale');
  }
  if (selector.role === 'snapshot' && selector.capturedAt === undefined) return;
  const query = homeGraphSourceCandidateQuery(selector), rows = db.exec(query.sql, query.params)[0];
  for (const values of rows?.values ?? []) { const other = from(rows!.columns, values); if (other.id !== record.id && homeGraphSourceMatches(other, selector)) throw new Held('ambiguous'); }
}
