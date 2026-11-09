/** Native input membership, not a semantic classification or permission token.
 * Helpers are entities that may also occur in the full entities group. */
import type { KnowledgeNodeRecord } from '../types.js';
import { homeGraphObjectId, nodeKindForHomeGraphObject, normalizeHomeGraphObjectInput, readRecord } from './helpers.js';
import { HomeGraphObjectIdentityError } from './identity-errors.js';
import type { HomeGraphNodeKind, HomeGraphObjectInput, HomeGraphSnapshotInput } from './types.js';
export const snapshotGroups = Object.freeze([
  ['entities', 'entity'], ['devices', 'device'], ['areas', 'area'], ['automations', 'automation'],
  ['scripts', 'script'], ['scenes', 'scene'], ['labels', 'label'], ['integrations', 'integration'], ['helpers', 'entity'],
] as const);
export type SnapshotGroup = typeof snapshotGroups[number][0];
export interface CapturedSnapshotGroups {
  readonly snapshot: HomeGraphSnapshotInput;
  readonly supplied: ReadonlySet<SnapshotGroup>;
  readonly members: ReadonlyMap<HomeGraphNodeKind, ReadonlyMap<string, ReadonlySet<SnapshotGroup>>>;
}
/** Complete input preflight precedes batch(): that API defers persistence and
 * cannot roll back an already written source or an earlier array member. */
export function captureSnapshotGroups(snapshot: HomeGraphSnapshotInput): CapturedSnapshotGroups {
  const normalized: { -readonly [Group in SnapshotGroup]?: readonly HomeGraphObjectInput[] } = {};
  const supplied = new Set<SnapshotGroup>(), members = new Map<HomeGraphNodeKind, Map<string, Set<SnapshotGroup>>>();
  for (const [group, kind] of snapshotGroups) {
    const input = snapshot[group]; if (input === undefined) continue;
    if (!Array.isArray(input)) throw new TypeError(`Home Graph ${group} must be an array.`);
    supplied.add(group);
    normalized[group] = input.map((object, index) => {
      let captured;
      try { captured = normalizeHomeGraphObjectInput(kind, object); }
      catch (error) { if (error instanceof HomeGraphObjectIdentityError) throw new HomeGraphObjectIdentityError(group, index); throw error; }
      const nodeKind = nodeKindForHomeGraphObject(kind), id = homeGraphObjectId(nodeKind, captured);
      let byId = members.get(nodeKind); if (!byId) { byId = new Map(); members.set(nodeKind, byId); }
      let groups = byId.get(id); if (!groups) { groups = new Set(); byId.set(id, groups); } groups.add(group);
      return captured;
    });
  }
  return { snapshot: { ...snapshot, ...normalized }, supplied, members };
}
/** Old producers had no helpers path; an unannotated entity is therefore an
 * entities member. Unknown saved annotations are preserved, never guessed. */
export function storedSnapshotGroups(node: KnowledgeNodeRecord): readonly SnapshotGroup[] {
  const homeAssistant = readRecord(node.metadata.homeAssistant), value = homeAssistant.snapshotGroups;
  if (value !== undefined) {
    if (!Array.isArray(value) || value.length === 0 || value.some(group => !snapshotGroups.some(([name, objectKind]) => group === name && nodeKindForHomeGraphObject(objectKind) === node.kind)) || new Set(value).size !== value.length) throw new Error('Saved Home Graph snapshot membership is unsupported; existing records were preserved.');
    return value as SnapshotGroup[];
  }
  const kind = homeAssistant.objectKind;
  return snapshotGroups.filter(([group, objectKind]) => group !== 'helpers' && objectKind === kind).map(([group]) => group);
}
export function currentSnapshotMembership(captured: CapturedSnapshotGroups, node: KnowledgeNodeRecord): readonly SnapshotGroup[] {
  const homeAssistant = readRecord(node.metadata.homeAssistant), id = homeAssistant.objectId;
  if (typeof id !== 'string') return storedSnapshotGroups(node).filter(group => !captured.supplied.has(group));
  const current = captured.members.get(node.kind as HomeGraphNodeKind)?.get(id) ?? new Set<SnapshotGroup>(), previous = storedSnapshotGroups(node);
  return snapshotGroups.map(([group]) => group).filter(group => current.has(group) || !captured.supplied.has(group) && previous.includes(group));
}
