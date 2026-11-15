import type {
  AgentWorkspaceActionResult,
  AgentWorkspaceLocalEditorKind,
  AgentWorkspaceLocalLibraryItem,
  AgentWorkspaceRuntimeSnapshot,
} from './agent-workspace-types.ts';

export type AgentWorkspaceLocalSelectionIndexes = Record<AgentWorkspaceLocalEditorKind, number>;
export type AgentWorkspaceLocalSelectionIds = Partial<Record<AgentWorkspaceLocalEditorKind, string>>;

/**
 * The selected record of each kind is held by id; the index is only where that
 * record sat in the last list it was resolved against. Lists reorder (a review
 * stamps `updatedAt`, newest first) and are re-read when another process writes,
 * so a position alone would point at a different record after any change.
 */
export interface AgentWorkspaceLocalSelection {
  readonly ids: AgentWorkspaceLocalSelectionIds;
  readonly indexes: AgentWorkspaceLocalSelectionIndexes;
}

export interface AgentWorkspaceLocalSelectionHost {
  readonly runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  readonly localSelection: AgentWorkspaceLocalSelection;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
  selectedLocalLibraryItem(kind: AgentWorkspaceLocalEditorKind): AgentWorkspaceLocalLibraryItem | null;
}

export function createAgentWorkspaceLocalSelection(): AgentWorkspaceLocalSelection {
  return { ids: {}, indexes: { memory: 0, note: 0, persona: 0, skill: 0, routine: 0, profile: 0 } };
}

export function agentWorkspaceLocalLibraryItems(
  snapshot: AgentWorkspaceRuntimeSnapshot | null,
  kind: AgentWorkspaceLocalEditorKind,
): readonly AgentWorkspaceLocalLibraryItem[] {
  if (kind === 'memory') return snapshot?.localMemories ?? [];
  if (kind === 'note') return snapshot?.localNotes ?? [];
  if (kind === 'persona') return snapshot?.localPersonas ?? [];
  if (kind === 'skill') return snapshot?.localSkills ?? [];
  if (kind === 'profile') return [];
  return snapshot?.localRoutines ?? [];
}

/** Position of the selected record: its id when it is still listed, else the nearest neighbour of where it was. */
function resolvedIndex(items: readonly AgentWorkspaceLocalLibraryItem[], selection: AgentWorkspaceLocalSelection, kind: AgentWorkspaceLocalEditorKind): number {
  const id = selection.ids[kind];
  if (id !== undefined) {
    const found = items.findIndex((item) => item.id === id);
    if (found >= 0) return found;
  }
  return Math.max(0, Math.min(selection.indexes[kind], items.length - 1));
}

export function selectedAgentWorkspaceLocalLibraryItem(
  snapshot: AgentWorkspaceRuntimeSnapshot | null,
  selection: AgentWorkspaceLocalSelection,
  kind: AgentWorkspaceLocalEditorKind,
): AgentWorkspaceLocalLibraryItem | null {
  const items = agentWorkspaceLocalLibraryItems(snapshot, kind);
  if (items.length === 0) return null;
  return items[resolvedIndex(items, selection, kind)] ?? null;
}

/** After a snapshot change: re-anchor the selection to its record, or to the neighbour that took its place. */
export function resolveAgentWorkspaceLocalLibrarySelection(
  snapshot: AgentWorkspaceRuntimeSnapshot | null,
  selection: AgentWorkspaceLocalSelection,
  kind: AgentWorkspaceLocalEditorKind,
): void {
  const items = agentWorkspaceLocalLibraryItems(snapshot, kind);
  if (items.length === 0) {
    selection.indexes[kind] = 0;
    delete selection.ids[kind];
    return;
  }
  const index = resolvedIndex(items, selection, kind);
  selection.indexes[kind] = index;
  selection.ids[kind] = items[index]!.id;
}

/** Select one record by id (a record just created or updated); unknown ids leave the selection as it is. */
export function selectAgentWorkspaceLocalLibraryItem(
  snapshot: AgentWorkspaceRuntimeSnapshot | null,
  selection: AgentWorkspaceLocalSelection,
  kind: AgentWorkspaceLocalEditorKind,
  id: string,
): void {
  const index = agentWorkspaceLocalLibraryItems(snapshot, kind).findIndex((item) => item.id === id);
  if (index < 0) return;
  selection.indexes[kind] = index;
  selection.ids[kind] = id;
}

export function moveAgentWorkspaceLocalLibraryItemSelection(
  host: AgentWorkspaceLocalSelectionHost,
  kind: AgentWorkspaceLocalEditorKind,
  delta: number,
): void {
  const items = agentWorkspaceLocalLibraryItems(host.runtimeSnapshot, kind);
  if (items.length === 0) {
    host.status = `No local ${kind} records to select.`;
    host.lastActionResult = {
      kind: 'guidance',
      title: `No ${kind} records`,
      detail: `Create a local ${kind} before using selection actions.`,
      safety: 'safe',
    };
    return;
  }
  const selection = host.localSelection;
  const index = Math.max(0, Math.min(items.length - 1, resolvedIndex(items, selection, kind) + delta));
  selection.indexes[kind] = index;
  selection.ids[kind] = items[index]!.id;
  const selected = host.selectedLocalLibraryItem(kind);
  host.status = selected ? `Selected ${kind}: ${selected.name} (${index + 1} of ${items.length}).` : `Selected ${kind} updated.`;
  host.lastActionResult = {
    kind: 'guidance',
    title: selected ? `Selected ${selected.name}` : `Selected ${kind}`,
    detail: selected ? `${selected.name} (${selected.id}) is now the selected local ${kind}, ${index + 1} of ${items.length}.` : `Selection changed for ${kind}.`,
    safety: 'safe',
  };
}
