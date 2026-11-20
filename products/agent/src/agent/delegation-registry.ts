import { readJsonStore, updateJsonStore, type JsonStoreSpec } from '@goodvibes/engine/terminal-shell/agent-turn/store-file';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

/** One hand-off of build work: the shared session it went to and the input that carries it. */
export interface AgentDelegationRecord {
  readonly sessionId: string;
  readonly task: string;
  readonly createdAt: string;
  /** The input the session broker recorded for the hand-off; absent when the submit result named none. */
  readonly inputId?: string;
  readonly reviewRequested: boolean;
}

/** Older hand-offs drop off the list; their sessions stay on the host. */
const MAX_DELEGATIONS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDelegation(value: unknown): AgentDelegationRecord | null {
  if (!isRecord(value)) return null;
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
  const task = typeof value.task === 'string' ? value.task : '';
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : '';
  if (!sessionId || !createdAt) return null;
  const inputId = typeof value.inputId === 'string' && value.inputId.trim() ? value.inputId.trim() : undefined;
  return { sessionId, task, createdAt, ...(inputId ? { inputId } : {}), reviewRequested: value.reviewRequested === true };
}

const DELEGATION_STORE: JsonStoreSpec<AgentDelegationRecord> = {
  label: 'delegation list',
  entriesKey: 'delegations',
  version: 1,
  parseEntry: parseDelegation,
};

export function delegationStorePath(shellPaths: Pick<ShellPathService, 'resolveUserPath'>): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'delegations', 'delegations.json');
}

export class AgentDelegationRegistry {
  public constructor(private readonly storePath: string) {}

  public static fromShellPaths(shellPaths: Pick<ShellPathService, 'resolveUserPath'>): AgentDelegationRegistry {
    return new AgentDelegationRegistry(delegationStorePath(shellPaths));
  }

  /** Newest first. */
  public list(): readonly AgentDelegationRecord[] {
    return [...readJsonStore(this.storePath, DELEGATION_STORE).entries].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** The hand-off whose session id is `query` or starts with it; null when none or more than one match. */
  public find(query: string): AgentDelegationRecord | null {
    const needle = query.trim();
    if (!needle) return null;
    const all = this.list();
    const exact = all.find((entry) => entry.sessionId === needle);
    if (exact) return exact;
    const matches = all.filter((entry) => entry.sessionId.startsWith(needle));
    return matches.length === 1 ? matches[0]! : null;
  }

  public record(entry: AgentDelegationRecord): void {
    updateJsonStore(this.storePath, DELEGATION_STORE, (store) => {
      const kept = store.entries.filter((existing) => existing.sessionId !== entry.sessionId);
      const entries = [...kept, entry].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-MAX_DELEGATIONS);
      return { value: undefined, entries };
    });
  }
}
