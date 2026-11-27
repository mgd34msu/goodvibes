/**
 * What every act on the Agent's stores shares (agent-store-runner.ts): the
 * context it runs in, and turning a store's failure into a refusal that says
 * what is true.
 */
import { CapabilityRefusal, UNNAMED_AUTHOR, authorWords, type ActionValues, type CapabilityResult, type RecordAuthor } from '@goodvibes/engine/platform/platform/capabilities';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { MemoryAccess } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import type { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import type { AgentConnectedHostConnection } from './routine-schedules.js';

/** What an act on a store is given: the stores' paths for the asking program's project, and the daemon's own services. */
export interface StoreActContext {
  /** The Agent's stores for this caller: the owner's home, and the asking program's project (the daemon's own when none was named). */
  readonly shellPaths: ShellPathService;
  /** The daemon's artifact store, which every program's saved artifacts are kept in. */
  readonly artifacts: Pick<ArtifactStore, 'list' | 'create'>;
  /** The one memory store, for a note kept as a memory. */
  readonly memory?: Pick<MemoryAccess, 'add'> | undefined;
  /** Add a web page to the daemon's one knowledge store (the act of `knowledge.ingest-url`); absent where it has none. */
  readonly ingestUrl?: ((input: { readonly url: string; readonly tags: readonly string[]; readonly folderPath: string }) => Promise<{ readonly source: { readonly id: string; readonly title?: string | undefined } }>) | undefined;
  /** The person asked it themselves (not a model, a script or another agent): a file outside the project is theirs to name. */
  readonly personAsked?: boolean | undefined;
  /**
   * Who writes what this act keeps that steers the owner's turns (a memory record, a persona, a note, a routine, a
   * skill), from the credential the daemon authenticated (capabilities/types.ts `CapabilityCaller.author`). Absent:
   * someone else's.
   */
  readonly author?: RecordAuthor | undefined;
  /** The caller named a project (its working directory); without one, a relative path has nothing to be relative to. */
  readonly projectGiven?: boolean | undefined;
  /** The daemon itself as the host a routine's schedule is made on (routine-schedules.ts); absent where it cannot be reached. */
  readonly scheduleHost?: (() => AgentConnectedHostConnection) | undefined;
  /** Run one of the Agent's store tools as the owner's confirmed act; its printed answer, or a refusal with its reason. */
  readonly tool: (name: string, args: Record<string, unknown>, what: string) => Promise<string>;
  /** Hand a kept research run to the daemon's research runner, which collects its sources in the background; absent with no web search. */
  readonly startResearch?: ((runId: string, name: string) => void) | undefined;
}

export type StoreAct = (values: ActionValues, context: StoreActContext) => Promise<CapabilityResult>;

/** One step against a store; a failure that is not a refusal becomes one, in the store's own words. */
export function storeStep<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof CapabilityRefusal) throw error;
    throw new CapabilityRefusal(error instanceof Error ? error.message : String(error));
  }
}

/** The same, for a step that waits. */
export async function storeStepAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CapabilityRefusal) throw error;
    throw new CapabilityRefusal(error instanceof Error ? error.message : String(error));
  }
}

/** Comma- or newline-separated words, trimmed, empty ones dropped. */
/**
 * A record's provenance with who wrote it when that was not the owner in person ("Command, written by someone else
 * (...)"): the Memory and knowledge place shows it.
 */
export function provenanceBy(context: Pick<StoreActContext, 'author'>, base: string): string {
  const words = authorWords(context.author);
  return words ? `${base}, ${words}` : base;
}

/** Who writes the record this act keeps, kept on it as its author (state/memory-author.ts); nobody named: someone else. */
export function writtenBy(context: Pick<StoreActContext, 'author'>): RecordAuthor {
  return context.author ?? UNNAMED_AUTHOR;
}

/**
 * Marking a persona, note or routine reviewed lets its text reach the prompt: it counts only from the owner in person
 * (their own press, their yes in Waiting for you), never from another credential's claim to be a person.
 */
export function ownersOwnReview(context: Pick<StoreActContext, 'author'>, what: string): void {
  if (context.author?.kind === 'owner') return;
  throw new CapabilityRefusal(`${what} is the owner's decision that its text may reach the prompt, so it counts only when the owner does it in person; nothing was changed.`,
    'Ask the owner to review it in Memory and knowledge.', 'OWNER_REVIEW_REQUIRED');
}

export function splitWords(value: string | undefined): readonly string[] {
  return (value ?? '').split(/[,\n]/).map((entry) => entry.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
}

/** A whole number of at least 1, or undefined for blank or not a number. */
export function positiveNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : undefined;
}

/** The fields of `values` that were given, so a blank optional value is left out of a call. */
export function given(values: ActionValues, ...ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const value = values[id]?.trim();
    if (value) out[id] = value;
  }
  return out;
}

/** A file's name without its folders or the `.md` ending, and a name made into a slug: how a found file is named back. */
export function recordLookupValues(name: string, path: string): readonly string[] {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const basename = path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  return [name, slug, path, basename].map((value) => value.trim().toLowerCase()).filter(Boolean);
}
