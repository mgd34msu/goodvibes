import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import type { ConfigManager } from '../config/manager.js';
import type { SessionMaintenanceStatus } from './session-maintenance.js';
import type { EcosystemRecommendation } from './ecosystem/recommendations.js';
import { resolveSurfaceDirectory } from './surface-root.js';
import { trySyncFileLock } from '../config/sync-file-lock.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export type GuidanceMode = 'off' | 'minimal' | 'guided';
export type GuidanceCategory = 'onboarding' | 'operational' | 'recovery' | 'optimization';

export interface GuidanceItem {
  readonly id: string;
  /**
   * Which occurrence of the condition this item reports (the approval waiting,
   * the providers that are degraded, the session under pressure). A dismissal
   * hides this occurrence only; the next one shows again.
   */
  readonly occurrence: string;
  readonly category: GuidanceCategory;
  readonly title: string;
  readonly summary: string;
  readonly commands: readonly string[];
}

export interface ContextualGuidanceSnapshot {
  readonly pendingApproval: boolean;
  /** The id of the approval that is waiting, so dismissing it does not hide the next one. */
  readonly pendingApprovalId?: string | undefined;
  readonly denialCount: number;
  readonly authRequiredMcpCount: number;
  /** Names of the MCP servers waiting for authentication. */
  readonly authRequiredMcpServers?: readonly string[] | undefined;
  readonly degradedProviderCount: number;
  /** Ids of the degraded providers. */
  readonly degradedProviders?: readonly string[] | undefined;
  readonly intelligenceUnavailable: boolean;
  readonly recommendations: readonly EcosystemRecommendation[];
  /** The session the context and denial items are about. */
  readonly sessionId?: string | undefined;
}

/** One dismissal: the occurrence it was made for and when. */
interface GuidanceDismissal {
  readonly occurrence: string;
  readonly at: number;
  /**
   * The recommendations dismissed before this one (an entry each, `<kind>:<entry id>`): a dismissed recommendation
   * never shows again, whichever is recommended next. 3.5.0 reads the latest one only and ignores this.
   */
  readonly earlier?: readonly string[] | undefined;
}

/** The guidance whose every dismissed occurrence stays dismissed: a recommendation is a thing, not a passing state. */
const KEEPS_EVERY_DISMISSAL = new Set(['ecosystem-recommendation']);
/** The most earlier dismissals kept for one piece of guidance; the oldest go first. */
const MAX_EARLIER = 200;

interface GuidanceDismissalStore {
  readonly version: 2;
  readonly dismissed: Record<string, GuidanceDismissal>;
}

export interface GuidancePersistenceOptions {
  readonly guidancePath?: string | undefined;
  readonly userRoot?: string | undefined;
  readonly homeDirectory?: string | undefined;
  readonly surfaceRoot?: string | undefined;
}

function resolveGuidancePath(options?: GuidancePersistenceOptions): string {
  if (options?.guidancePath) {
    return options.guidancePath;
  }
  const userRoot = options?.userRoot ?? options?.homeDirectory;
  if (!userRoot) {
    throw new Error('Guidance persistence requires guidancePath or an explicit userRoot/homeDirectory.');
  }
  if (!options?.surfaceRoot) {
    throw new Error('Guidance persistence requires surfaceRoot when deriving guidancePath.');
  }
  return resolveSurfaceDirectory(userRoot, options.surfaceRoot, 'guidance.json');
}

/**
 * The stored dismissals, an empty store when there is no file (or a corrupt one
 * was set aside), and null when the file exists but could not be read. A
 * failed read must never be turned into a write, or one unreadable file wipes
 * every dismissal that was stored.
 */
/** Stores read with a dismissal in a 3.5.0 form, carried to this version's form in memory (written back once). */
const CARRIED = new WeakSet<GuidanceDismissalStore>();

/**
 * A recommendation's occurrence is its entry (`<kind>:<entry id>`). 3.5.0 keyed it by the line it told a person to type,
 * `/marketplace review <kind> <entry id>`: that form is the same entry, so a recommendation dismissed then stays dismissed.
 */
function carriedOccurrence(id: string, occurrence: string): string {
  if (id !== 'ecosystem-recommendation') return occurrence;
  const old = /^\/marketplace review (\S+) (\S+)$/.exec(occurrence.trim());
  return old ? `${old[1]}:${old[2]}` : occurrence;
}

function readDismissals(options?: GuidancePersistenceOptions): GuidanceDismissalStore | null {
  const empty: GuidanceDismissalStore = { version: 2, dismissed: {} };
  let carried = false;
  try {
    const store = (
      readJsonFileOrQuarantine<GuidanceDismissalStore>(resolveGuidancePath(options), {
        label: 'runtime/guidance',
        recovery: 'Previously dismissed guidance messages may appear once more; dismissing them again is all that is needed.',
        validate: (parsed) => {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('guidance dismissal store is not a JSON object');
          }
          const raw = parsed as { dismissed?: unknown };
          if (!raw.dismissed || typeof raw.dismissed !== 'object' || Array.isArray(raw.dismissed)) {
            throw new Error('guidance dismissal store is missing its dismissed map');
          }
          // A dismissal written before occurrences were recorded (a bare
          // timestamp) names no occurrence, so it hides nothing.
          const dismissed: Record<string, GuidanceDismissal> = {};
          for (const [id, value] of Object.entries(raw.dismissed as Record<string, unknown>)) {
            const entry = value as Partial<GuidanceDismissal> | null;
            if (entry && typeof entry === 'object' && typeof entry.occurrence === 'string') {
              const occurrence = carriedOccurrence(id, entry.occurrence);
              if (occurrence !== entry.occurrence) carried = true;
              const earlier = Array.isArray(entry.earlier) ? entry.earlier.filter((one): one is string => typeof one === 'string') : [];
              dismissed[id] = { occurrence, at: typeof entry.at === 'number' ? entry.at : 0, ...(earlier.length > 0 ? { earlier } : {}) };
            }
          }
          return { version: 2, dismissed };
        },
      }) ?? empty
    );
    if (carried) CARRIED.add(store);
    return store;
  } catch (error) {
    logger.warn('runtime/guidance: the dismissal store could not be read', { error: summarizeError(error) });
    return null;
  }
}

/**
 * Run a read-modify-write of the dismissal store under the shared file lock,
 * so two surfaces dismissing different items cannot overwrite each other.
 * Returns false, having changed nothing, when another process holds the store
 * or it cannot be read: a failed read is never turned into a write.
 */
function updateDismissals(options: GuidancePersistenceOptions | undefined, update: (store: GuidanceDismissalStore) => void): boolean {
  try {
    const path = resolveGuidancePath(options);
    const attempt = trySyncFileLock(path, () => {
      const store = readDismissals(options);
      if (!store) return false;
      update(store);
      writeJsonFileAtomic(path, store);
      return true;
    });
    if (!attempt.ran) {
      logger.warn('runtime/guidance: another process is updating the dismissal store; nothing was changed', { path });
      return false;
    }
    return attempt.value;
  } catch (error) {
    logger.warn('runtime/guidance: updating the dismissal store failed; nothing was changed', { error: summarizeError(error) });
    return false;
  }
}

/**
 * Remember that this occurrence of a guidance item was dismissed. The same
 * condition coming back as a new occurrence (another approval, another
 * provider failing, another session) shows again. False when it could not be saved.
 */
export function dismissGuidance(item: Pick<GuidanceItem, 'id' | 'occurrence'>, options?: GuidancePersistenceOptions): boolean {
  return updateDismissals(options, (store) => {
    const before = store.dismissed[item.id];
    // A recommendation dismissed before stays dismissed when another is dismissed after it.
    const earlier = KEEPS_EVERY_DISMISSAL.has(item.id) && before
      ? [...(before.earlier ?? []), before.occurrence].filter((one) => one !== item.occurrence).slice(-MAX_EARLIER)
      : [];
    store.dismissed[item.id] = { occurrence: item.occurrence, at: Date.now(), ...(earlier.length > 0 ? { earlier } : {}) };
  });
}

/** Show a dismissed message again (all of them with no id). False when it could not be saved. */
export function resetGuidance(id?: string, options?: GuidancePersistenceOptions): boolean {
  return updateDismissals(options, (store) => {
    if (id) delete store.dismissed[id];
    else for (const key of Object.keys(store.dismissed)) delete store.dismissed[key];
  });
}

function sortedKey(values: readonly string[] | undefined, fallback: string): string {
  return values && values.length > 0 ? [...values].sort().join(',') : fallback;
}

export function evaluateContextualGuidance(
  configManager: ConfigManager,
  snapshot: ContextualGuidanceSnapshot,
  maintenance: SessionMaintenanceStatus,
  options?: GuidancePersistenceOptions,
): GuidanceItem[] {
  const mode = (configManager.get('behavior.guidanceMode') as GuidanceMode | undefined) ?? 'minimal';
  if (mode === 'off') return [];

  const items: GuidanceItem[] = [];
  const session = snapshot.sessionId ?? 'session';

  if (maintenance.level === 'suggest-compact' || maintenance.level === 'needs-repair') {
    items.push({
      id: 'context-maintenance',
      occurrence: `${session}:${maintenance.level}`,
      category: 'recovery',
      title: 'Context pressure needs attention',
      summary: 'The active session is near or beyond its healthy context budget.',
      commands: maintenance.nextSteps,
    });
  } else if (mode === 'guided' && maintenance.level === 'watch') {
    items.push({
      id: 'context-watch',
      occurrence: `${session}:${maintenance.level}`,
      category: 'optimization',
      title: 'Context pressure is rising',
      summary: 'Context is still healthy, but it is moving toward the configured compaction threshold.',
      commands: maintenance.nextSteps,
    });
  }

  if (snapshot.pendingApproval) {
    items.push({
      id: 'pending-approval',
      // Keyed by the approval waiting, so dismissing it never hides the next
      // one; without an id, by session, so it never hides another session's.
      occurrence: snapshot.pendingApprovalId ?? `${session}:pending`,
      category: 'recovery',
      title: 'A permission decision is waiting',
      summary: 'Operator approval is currently blocking the active workflow.',
      commands: ['Waiting for you (in the menu)', 'Permissions and safety (in the menu)'],
    });
  }

  if (snapshot.denialCount >= 3 && mode === 'guided') {
    items.push({
      id: 'repeated-denials',
      occurrence: session,
      category: 'operational',
      title: 'Repeated denials suggest a policy mismatch',
      summary: 'Several actions were denied in this session. Review whether a scoped durable rule should be added.',
      commands: ['Permissions and safety, Rules (in the menu)', 'Waiting for you (in the menu)'],
    });
  }

  if (snapshot.authRequiredMcpCount > 0) {
    items.push({
      id: 'mcp-auth-required',
      occurrence: sortedKey(snapshot.authRequiredMcpServers, String(snapshot.authRequiredMcpCount)),
      category: 'recovery',
      title: 'One or more MCP servers require authentication',
      summary: `${snapshot.authRequiredMcpCount} MCP server${snapshot.authRequiredMcpCount === 1 ? '' : 's'} cannot operate until auth is completed.`,
      // The services' own check is a control in Models and providers (Services, check every service).
      commands: ['/mcp'],
    });
  }

  if (snapshot.degradedProviderCount > 0) {
    items.push({
      id: 'provider-health',
      occurrence: sortedKey(snapshot.degradedProviders, String(snapshot.degradedProviderCount)),
      category: 'recovery',
      title: 'Provider health is degraded',
      summary: 'At least one configured provider is rate-limited, unavailable, or in an auth error state. The Providers tab of Models and providers shows which one, and how to fix it.',
      commands: ['Models and providers, Providers (in the menu)'],
    });
  }

  if (mode === 'guided' && snapshot.intelligenceUnavailable) {
    items.push({
      id: 'intelligence-setup',
      occurrence: 'unavailable',
      category: 'onboarding',
      title: 'Workspace intelligence is not ready',
      summary: 'Diagnostics and symbol search are unavailable for this workspace. Enable or configure intelligence to improve code-aware workflows.',
      commands: ['Code and changes, Code intelligence (in the menu)'],
    });
  }

  // The store is read when there is a recommendation, so the best one not dismissed is the one shown.
  let store: GuidanceDismissalStore | null | undefined;
  const hidden = (id: string, occurrence: string): boolean => {
    if (store === undefined) store = readDismissals(options);
    const dismissal = store?.dismissed[id];
    return dismissal !== undefined && (dismissal.occurrence === occurrence || dismissal.earlier?.includes(occurrence) === true);
  };
  const top = snapshot.recommendations.find((recommendation) => !hidden('ecosystem-recommendation', recommendation.id));
  if (top) {
    items.push({
      id: 'ecosystem-recommendation',
      // The entry recommended, never the words that point at it: a change of words does not show a dismissed one again.
      occurrence: top.id,
      category: 'operational',
      title: top.title,
      summary: top.reason,
      commands: [top.command, '"what fits this project" on the same tab'],
    });
  }

  // The dismissal store is read only when there is something it could hide,
  // so the usual empty evaluation costs no file read.
  if (items.length === 0 && store === undefined) return items;
  const shown = items.filter((item) => !hidden(item.id, item.occurrence));
  // A 3.5.0 dismissal read in its old form is written back in this version's form, once (nothing else changes).
  if (store && CARRIED.has(store)) updateDismissals(options, () => {});
  return shown;
}

export function formatGuidanceItems(items: readonly GuidanceItem[]): string[] {
  if (items.length === 0) return ['No active guidance items.'];
  return items.flatMap((item) => [
    `[${item.category}] ${item.title}`,
    `  ${item.summary}`,
    ...(item.commands.length > 0 ? [`  next: ${item.commands.join('  ')}`] : []),
    `  dismiss: "Dismiss a piece of guidance" in This conversation, then ${item.id}`,
  ]);
}
