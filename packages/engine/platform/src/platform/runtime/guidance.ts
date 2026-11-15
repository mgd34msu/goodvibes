import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import type { ConfigManager } from '../config/manager.js';
import type { SessionMaintenanceStatus } from './session-maintenance.js';
import type { EcosystemRecommendation } from './ecosystem/recommendations.js';
import { resolveSurfaceDirectory } from './surface-root.js';
import { tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export type GuidanceMode = 'off' | 'minimal' | 'guided';
export type GuidanceCategory = 'onboarding' | 'operational' | 'recovery' | 'optimization';

export interface GuidanceItem {
  readonly id: string;
  readonly category: GuidanceCategory;
  readonly title: string;
  readonly summary: string;
  readonly commands: readonly string[];
}

export interface ContextualGuidanceSnapshot {
  readonly pendingApproval: boolean;
  readonly denialCount: number;
  readonly authRequiredMcpCount: number;
  readonly degradedProviderCount: number;
  readonly intelligenceUnavailable: boolean;
  readonly recommendations: readonly EcosystemRecommendation[];
}

interface GuidanceDismissalStore {
  readonly version: 1;
  readonly dismissed: Record<string, number>;
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
function readDismissals(options?: GuidancePersistenceOptions): GuidanceDismissalStore | null {
  const empty: GuidanceDismissalStore = { version: 1, dismissed: {} };
  try {
    return (
      readJsonFileOrQuarantine<GuidanceDismissalStore>(resolveGuidancePath(options), {
        label: 'runtime/guidance',
        recovery: 'Previously dismissed guidance messages may appear once more; dismissing them again is all that is needed.',
        validate: (parsed) => {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('guidance dismissal store is not a JSON object');
          }
          const store = parsed as Partial<GuidanceDismissalStore>;
          if (!store.dismissed || typeof store.dismissed !== 'object' || Array.isArray(store.dismissed)) {
            throw new Error('guidance dismissal store is missing its dismissed map');
          }
          return { version: 1, dismissed: store.dismissed as Record<string, number> };
        },
      }) ?? empty
    );
  } catch (error) {
    logger.warn('runtime/guidance: the dismissal store could not be read', { error: summarizeError(error) });
    return null;
  }
}

function writeDismissals(store: GuidanceDismissalStore, options?: GuidancePersistenceOptions): void {
  writeJsonFileAtomic(resolveGuidancePath(options), store);
}

const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_MS = 25;

/**
 * Run a read-modify-write of the dismissal store while holding a cross-process
 * lock, so two surfaces dismissing different ids cannot overwrite each other.
 * Returns false, having changed nothing, when the lock stays busy or the store
 * cannot be read.
 */
function updateDismissals(options: GuidancePersistenceOptions | undefined, update: (store: GuidanceDismissalStore) => void): boolean {
  const lockPath = `${resolveGuidancePath(options)}.lock`;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let unlock: (() => void) | null = null;
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS && !unlock; attempt++) {
      unlock = tryAcquireCrossProcessLock(lockPath);
      if (!unlock) Atomics.wait(pause, 0, 0, LOCK_RETRY_MS);
    }
    if (!unlock) {
      logger.warn('runtime/guidance: another process is updating the dismissal store; nothing was changed', { lockPath });
      return false;
    }
    const store = readDismissals(options);
    if (!store) return false;
    update(store);
    writeDismissals(store, options);
    return true;
  } catch (error) {
    logger.warn('runtime/guidance: updating the dismissal store failed; nothing was changed', { error: summarizeError(error) });
    return false;
  } finally { unlock?.(); }
}

/** Remember that a guidance message was dismissed. False when it could not be saved. */
export function dismissGuidance(id: string, options?: GuidancePersistenceOptions): boolean {
  return updateDismissals(options, (store) => { store.dismissed[id] = Date.now(); });
}

/** Show a dismissed message again (all of them with no id). False when it could not be saved. */
export function resetGuidance(id?: string, options?: GuidancePersistenceOptions): boolean {
  return updateDismissals(options, (store) => {
    if (id) delete store.dismissed[id];
    else for (const key of Object.keys(store.dismissed)) delete store.dismissed[key];
  });
}

export function evaluateContextualGuidance(
  configManager: ConfigManager,
  snapshot: ContextualGuidanceSnapshot,
  maintenance: SessionMaintenanceStatus,
  options?: GuidancePersistenceOptions,
): GuidanceItem[] {
  const mode = (configManager.get('behavior.guidanceMode') as GuidanceMode | undefined) ?? 'minimal';
  if (mode === 'off') return [];

  const dismissed = readDismissals(options)?.dismissed ?? {};
  const items: GuidanceItem[] = [];

  if (maintenance.level === 'suggest-compact' || maintenance.level === 'needs-repair') {
    items.push({
      id: 'context-maintenance',
      category: 'recovery',
      title: 'Context pressure needs attention',
      summary: 'The active session is near or beyond its healthy context budget.',
      commands: maintenance.nextSteps,
    });
  } else if (mode === 'guided' && maintenance.level === 'watch') {
    items.push({
      id: 'context-watch',
      category: 'optimization',
      title: 'Context pressure is rising',
      summary: 'Context is still healthy, but it is moving toward the configured compaction threshold.',
      commands: maintenance.nextSteps,
    });
  }

  if (snapshot.pendingApproval) {
    items.push({
      id: 'pending-approval',
      category: 'recovery',
      title: 'A permission decision is waiting',
      summary: 'Operator approval is currently blocking the active workflow.',
      commands: ['/approval', '/security'],
    });
  }

  if (snapshot.denialCount >= 3 && mode === 'guided') {
    items.push({
      id: 'repeated-denials',
      category: 'operational',
      title: 'Repeated denials suggest a policy mismatch',
      summary: 'Several actions were denied in this session. Review whether a scoped durable rule should be added.',
      commands: ['/policy', '/security', '/approval'],
    });
  }

  if (snapshot.authRequiredMcpCount > 0) {
    items.push({
      id: 'mcp-auth-required',
      category: 'recovery',
      title: 'One or more MCP servers require authentication',
      summary: `${snapshot.authRequiredMcpCount} MCP server${snapshot.authRequiredMcpCount === 1 ? '' : 's'} cannot operate until auth is completed.`,
      commands: ['/mcp', '/services auth-review'],
    });
  }

  if (snapshot.degradedProviderCount > 0) {
    items.push({
      id: 'provider-health',
      category: 'recovery',
      title: 'Provider health is degraded',
      summary: 'At least one configured provider is rate-limited, unavailable, or in an auth error state.',
      commands: ['/provider', '/health'],
    });
  }

  if (mode === 'guided' && snapshot.intelligenceUnavailable) {
    items.push({
      id: 'intelligence-setup',
      category: 'onboarding',
      title: 'Workspace intelligence is not ready',
      summary: 'Diagnostics and symbol search are unavailable for this workspace. Enable or configure intelligence to improve code-aware workflows.',
      commands: ['/setup onboarding', '/health'],
    });
  }

  if (snapshot.recommendations.length > 0) {
    const top = snapshot.recommendations[0]!;
    items.push({
      id: 'ecosystem-recommendation',
      category: 'operational',
      title: top.title,
      summary: top.reason,
      commands: [top.command, '/marketplace recommend'],
    });
  }

  return items.filter((item) => !(item.id in dismissed));
}

export function formatGuidanceItems(items: readonly GuidanceItem[]): string[] {
  if (items.length === 0) return ['No active guidance items.'];
  return items.flatMap((item) => [
    `[${item.category}] ${item.title}`,
    `  ${item.summary}`,
    ...(item.commands.length > 0 ? [`  next: ${item.commands.join('  ')}`] : []),
    `  dismiss: /guidance dismiss ${item.id}`,
  ]);
}
