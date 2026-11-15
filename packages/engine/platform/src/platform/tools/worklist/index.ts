import { existsSync } from 'node:fs';
import type { Tool } from '../../types/tools.js';
import { resolveScopedDirectory } from '../../runtime/surface-root.js';
import { WORKLIST_TOOL_SCHEMA, type WorklistToolInput } from './schema.js';
import { toRecord } from '../../utils/record-coerce.js';
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../../utils/atomic-json-store.js';

interface WorklistItem {
  readonly id: string;
  readonly text: string;
  readonly status: 'open' | 'done';
  readonly owner?: string | undefined;
  readonly priority: 'low' | 'medium' | 'high';
}

interface WorklistRecord {
  readonly id: string;
  readonly title: string;
  readonly items: readonly WorklistItem[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface WorklistFile {
  readonly version: 1;
  readonly worklists: readonly WorklistRecord[];
}

type WorklistExecutionInput = WorklistToolInput;

function summarizeWorklist(record: WorklistRecord) {
  const openCount = record.items.filter((item) => item.status === 'open').length;
  const doneCount = record.items.filter((item) => item.status === 'done').length;
  return {
    id: record.id,
    title: record.title,
    itemCount: record.items.length,
    openCount,
    doneCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function worklistsPath(storageRoot: string, surfaceRoot?: string): string {
  return resolveScopedDirectory(storageRoot, surfaceRoot, 'worklists.json');
}

/** The stored worklists, plus a notice when an unreadable file had to be set aside. */
function loadWorklists(storageRoot: string, surfaceRoot?: string): { readonly worklists: WorklistRecord[]; readonly notice?: string } {
  const path = worklistsPath(storageRoot, surfaceRoot);
  const existed = existsSync(path);
  const parsed = readJsonFileOrQuarantine<WorklistFile>(path, {
    label: 'worklist',
    validate: (value) => {
      const file = value as WorklistFile | null;
      if (file?.version !== 1 || !Array.isArray(file.worklists)) throw new Error('worklist store is malformed');
      return file;
    },
    recovery: 'The worklist tool starts with no worklists; the unreadable file is kept beside the store for recovery.',
  });
  if (parsed) return { worklists: [...parsed.worklists] };
  return existed
    ? { worklists: [], notice: `The worklist file ${path} was unreadable. It was kept beside the store as ${path}.corrupt-<time>, and the worklists start empty; copy items back from it if you need them.` }
    : { worklists: [] };
}

function saveWorklists(storageRoot: string, worklists: readonly WorklistRecord[], surfaceRoot?: string): void {
  // Written to a temp file and renamed, so a crash leaves the old file, never a torn one.
  writeJsonFileAtomic(worklistsPath(storageRoot, surfaceRoot), { version: 1, worklists });
}

export function createWorklistTool(options?: { readonly surfaceRoot?: string; readonly workingDirectory?: string }): Tool {
  const surfaceRoot = options?.surfaceRoot;
  // The host's working directory is the store root. A model-supplied path is never
  // honoured: the schema has no such field, and an extra argument must not pick where the file is written.
  const hostStorageRoot = options?.workingDirectory;
  return {
    definition: {
      name: 'worklist',
      description: 'Manage durable worklists and checklist items for execution planning and follow-up.',
      parameters: toRecord(WORKLIST_TOOL_SCHEMA),
      sideEffects: ['workflow', 'state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as WorklistExecutionInput;
      const storageRoot = hostStorageRoot;
      if (!storageRoot || storageRoot.trim().length === 0) {
        return { success: false, error: 'worklist is not set up in this session: the host gave it no working directory. Nothing was read or changed; do not retry.' };
      }
      const { worklists, notice } = loadWorklists(storageRoot, surfaceRoot);
      const reply = (payload: Record<string, unknown>) => ({ success: true, output: JSON.stringify(notice ? { ...payload, notice } : payload) });
      const view = input.view ?? 'summary';

      if (input.mode === 'create') {
        if (!input.worklistId || !input.title) {
          return { success: false, error: 'create requires worklistId and title.' };
        }
        if (worklists.some((entry) => entry.id === input.worklistId)) {
          return { success: false, error: `Worklist already exists: ${input.worklistId}` };
        }
        const now = Date.now();
        const record: WorklistRecord = {
          id: input.worklistId,
          title: input.title,
          items: [],
          createdAt: now,
          updatedAt: now,
        };
        saveWorklists(storageRoot, [...worklists, record], surfaceRoot);
        return reply({ ...record });
      }

      if (input.mode === 'list') {
        return reply({
          view,
          count: worklists.length,
          worklists: view === 'full' ? worklists : worklists.map(summarizeWorklist),
        });
      }

      const index = worklists.findIndex((entry) => entry.id === input.worklistId);
      if (index < 0) {
        return { success: false, error: `Unknown worklist: ${input.worklistId ?? '(missing)'}` };
      }
      const current = worklists[index]!;

      if (input.mode === 'show') {
        return reply(view === 'full' ? { ...current } : {
          ...summarizeWorklist(current),
          items: current.items.map((item) => ({
            id: item.id,
            text: item.text,
            status: item.status,
            owner: item.owner,
            priority: item.priority,
          })),
        });
      }

      if (input.mode === 'add-item') {
        if (!input.itemId || !input.text) return { success: false, error: 'add-item requires itemId and text.' };
        // Re-adding would reset the item to open and drop its owner; say so instead of doing it silently.
        const existing = current.items.find((item) => item.id === input.itemId);
        if (existing) {
          return { success: false, error: `Item ${input.itemId} already exists in worklist ${current.id} (status ${existing.status}). Nothing was changed. Use a new itemId, or remove-item it first to replace it.` };
        }
        const next: WorklistRecord = {
          ...current,
          items: [
            ...current.items,
            { id: input.itemId, text: input.text, status: 'open', priority: input.priority ?? 'medium', ...(input.owner ? { owner: input.owner } : {}) },
          ],
          updatedAt: Date.now(),
        };
        worklists[index] = next;
        saveWorklists(storageRoot, worklists, surfaceRoot);
        return reply({ ...next });
      }

      if (!input.itemId) return { success: false, error: `${input.mode} requires itemId.` };
      if (!current.items.some((item) => item.id === input.itemId)) {
        return { success: false, error: `Unknown item ${input.itemId} in worklist ${current.id}; nothing was changed. Known items: ${current.items.map((item) => item.id).join(', ') || '(none)'}.` };
      }
      const nextItems = current.items
        .filter((item) => input.mode !== 'remove-item' || item.id !== input.itemId)
        .map((item) => {
          if (item.id !== input.itemId) return item;
          if (input.mode === 'complete-item') return { ...item, status: 'done' as const };
          if (input.mode === 'reopen-item') return { ...item, status: 'open' as const };
          return item;
        });
      const next: WorklistRecord = {
        ...current,
        items: nextItems,
        updatedAt: Date.now(),
      };
      worklists[index] = next;
      saveWorklists(storageRoot, worklists, surfaceRoot);
      return reply({ ...next });
    },
  };
}

export const worklistTool = createWorklistTool();
