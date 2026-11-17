import type { SessionEvent } from '@goodvibes-jev/engine/platform/events';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createFeatureFlagManager } from '@goodvibes-jev/engine/platform/platform/runtime/feature-flags/manager';
import { deriveFeatureStates, bindFeatureSettingsBridge } from '@goodvibes-jev/engine/platform/platform/runtime/feature-flags/feature-settings';
import {
  RuntimeEventBus,
  configureRuntimeEventBusDefaults,
  runtimeEventBusOptionsFrom,
} from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { createRuntimeStore, createDomainDispatch } from '@goodvibes-jev/engine/platform/platform/runtime/store';
import type { DomainDispatch } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { attachSessionRecoveryState } from '@goodvibes-jev/engine/platform/platform/runtime/emitters';
import type { OrchestratorUserInputOptions } from '@goodvibes-jev/engine/platform/platform/core';
import type { Notifier } from '@goodvibes-jev/engine/platform/platform/integrations';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { holdProcessLock, logger, summarizeError, type HeldProcessLock } from '@goodvibes-jev/engine/platform/platform/utils';
import { companionMessageToOrchestratorInputOptions } from './companion-input.js';
const featureFlagBridgeTeardowns = new WeakMap<object, () => void>();
export function createTerminalFeatureFlags(config: ConfigManager) {
  const flags = createFeatureFlagManager();
  flags.loadFromConfig({ flags: deriveFeatureStates(config) });
  featureFlagBridgeTeardowns.set(flags, bindFeatureSettingsBridge(config, flags));
  return flags;
}
/** Detach the config subscription `createTerminalFeatureFlags` attached, so a disposed runtime is not kept alive by the config manager. */
export function disposeTerminalFeatureFlags(flags: object): void {
  const teardown = featureFlagBridgeTeardowns.get(flags);
  if (teardown === undefined) return;
  featureFlagBridgeTeardowns.delete(flags);
  teardown();
}
export function createTerminalEventState(config: Pick<ConfigManager, 'get'>) {
  configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => config.get(key)));
  const runtimeBus = new RuntimeEventBus();
  const store = createRuntimeStore();
  const domainDispatch = createDomainDispatch(store);
  // The session recovery state the store shows is derived from the session
  // events (loading, repairing, ready, recovery failed); it lives as long as the bus.
  attachSessionRecoveryState(runtimeBus, domainDispatch);
  return { runtimeBus, store, domainDispatch };
}
export async function initializeTerminalMemory(
  store: { init(): Promise<unknown>; save(): Promise<unknown>; close(): unknown },
  unsubs: Array<() => void | Promise<void>>,
): Promise<void> {
  await store.init();
  unsubs.push(async () => {
    try {
      await store.save();
    } finally {
      store.close();
    }
  });
}
export function attachTerminalCompanionInput(
  bus: Pick<RuntimeEventBus, 'on'>,
  handler: { value: ((text: string, options?: OrchestratorUserInputOptions) => void) | null },
  conversation: { addUserMessage(text: string): unknown },
  render: () => void,
  narrate?: (payload: Extract<SessionEvent, { type: 'COMPANION_MESSAGE_RECEIVED' }>) => void,
  options: {
    /** The session this terminal is running. When given, a message addressed to any other session is ignored. */
    readonly activeSessionId?: (() => string | undefined) | undefined;
    /** Told when a message arrives before the orchestrator is ready and so is recorded but not answered. */
    readonly notice?: ((text: string) => void) | undefined;
  } = {},
): () => void {
  return bus.on<Extract<SessionEvent, { type: 'COMPANION_MESSAGE_RECEIVED' }>>('COMPANION_MESSAGE_RECEIVED', ({ payload }) => {
    const active = options.activeSessionId?.();
    if (active !== undefined && payload.sessionId !== active) return;
    narrate?.(payload);
    if (handler.value) handler.value(payload.body, companionMessageToOrchestratorInputOptions(payload));
    else {
      conversation.addUserMessage(payload.body);
      options.notice?.('A companion message arrived before the assistant was ready. It is shown in the conversation but no turn was started; send it again to get an answer.');
      render();
    }
  });
}
export function seedTerminalSession(dispatch: Pick<DomainDispatch, 'syncSessionState'>, sessionId: string, projectRoot: string): void {
  dispatch.syncSessionState(
    {
      id: sessionId,
      conversationSessionId: sessionId,
      projectRoot,
      status: 'active',
      startedAt: Date.now(),
      recoveryState: 'ready',
      isResumed: false,
      wasRepaired: false,
      lineageId: sessionId,
      lineage: [{ sessionId, createdAt: Date.now() }],
    },
    'bootstrap.session',
  );
}
/**
 * Attach the Slack and Discord notifier to the runtime bus and mirror its
 * delivery queues into the integrations domain. The notifier is attached even
 * with no channel yet: it resolves its channels at send time, so a token saved
 * during the session delivers the next notification. The rows are written now
 * and again whenever the notifier's channels change or a notification fails. A
 * chat service connected with a bot token but no notification target gets a
 * degraded row that names what to add, as the daemon shows it.
 */
export function syncTerminalNotifierQueues(
  notifier: Pick<Notifier, 'getQueueStatus' | 'onChannelsChanged' | 'channelGaps' | 'onDeadLetter'>,
  dispatch: Pick<DomainDispatch, 'syncIntegration'>,
  attach: () => () => void,
): () => void {
  const unsubscribe = attach();
  let shown = new Set<string>();
  const syncRows = (): void => {
    const queues = notifier.getQueueStatus();
    const gaps = notifier.channelGaps();
    const now = new Set([...queues.map((queue) => queue.channel), ...gaps.map((gap) => gap.channel)]);
    for (const gone of shown) {
      if (now.has(gone)) continue;
      dispatch.syncIntegration(
        { id: gone, displayName: gone[0]!.toUpperCase() + gone.slice(1), category: 'communication', status: 'unconfigured', enabled: false, successCount: 0, errorCount: 0, meta: {} },
        'bootstrap.notifier',
      );
    }
    shown = now;
    for (const gap of gaps) {
      dispatch.syncIntegration(
        {
          id: gap.channel, displayName: gap.channel[0]!.toUpperCase() + gap.channel.slice(1),
          category: 'communication', status: 'degraded', enabled: true, successCount: 0, errorCount: 0,
          lastError: `${gap.reason}. ${gap.next}.`,
          meta: { notifications: 'no-target', next: gap.next },
        },
        'bootstrap.notifier',
      );
    }
    for (const queue of queues) {
      dispatch.syncIntegration(
        {
          id: queue.channel,
          displayName: queue.channel[0]!.toUpperCase() + queue.channel.slice(1),
          category: 'communication',
          status: queue.metrics.deadLettered > 0 ? 'degraded' : queue.metrics.delivered > 0 ? 'healthy' : 'configured',
          enabled: true,
          successCount: queue.metrics.delivered,
          errorCount: queue.metrics.deadLettered,
          ...(queue.dlqEntries[0]?.deadAt ? { lastErrorAt: queue.dlqEntries[0].deadAt } : {}),
          ...(queue.dlqEntries[0]?.finalError ? { lastError: queue.dlqEntries[0].finalError } : {}),
          meta: {
            attempts: queue.metrics.totalAttempts,
            retrying: queue.metrics.retrying,
            deadLetters: queue.metrics.deadLettered,
            dlqSize: queue.metrics.dlqSize,
            sloEnforced: queue.sloEnforced,
          },
        },
        'bootstrap.notifier',
      );
    }
  };
  syncRows();
  const stopRows = notifier.onChannelsChanged(syncRows);
  const stopFailures = notifier.onDeadLetter(syncRows);
  return () => { stopRows(); stopFailures(); unsubscribe(); };
}

/** How many terminals at once keep their failed notifications on disk; one more keeps them in memory. */
const DEAD_LETTER_SLOTS = 8;

/**
 * Keep a notifier's failed notifications on disk so `/notify failed` and
 * `/notify resend` still have them after a restart. Several terminals can run
 * at once, and each writes its whole list on every change, so each holds one
 * of a few numbered files under a kernel-released lock instead of sharing one.
 * At start it takes the first free file (with whatever an earlier terminal
 * left there) and takes over the list of any other file whose terminal has
 * exited. Cost: one lock open at start for the own file, plus one per other
 * file that holds a list; one file write per failed, resent or cleared
 * notification, nothing on a delivery that succeeds. Returns the release.
 */
export function keepTerminalDeadLetters(
  notifier: { persistDeadLetters(path: string): void },
  directory: string,
  kind: string,
): () => void {
  const fileFor = (slot: number): string => join(directory, `${kind}-${slot}.json`);
  const lockFor = (slot: number): string => `${fileFor(slot)}.writer.sqlite`;
  let own: { readonly slot: number; readonly lock: HeldProcessLock } | null = null;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (let slot = 0; slot < DEAD_LETTER_SLOTS && !own; slot++) {
      const lock = holdProcessLock(lockFor(slot));
      if (lock) own = { slot, lock };
    }
    if (!own) {
      logger.warn('Failed notifications from this terminal are kept in memory only: every dead-letter file is in use by another terminal', { directory, kind });
      return () => {};
    }
    const adopted: { readonly slot: number; readonly lock: HeldProcessLock }[] = [];
    for (let slot = 0; slot < DEAD_LETTER_SLOTS; slot++) {
      if (slot === own.slot || !existsSync(fileFor(slot))) continue;
      const lock = holdProcessLock(lockFor(slot));
      if (!lock) continue; // A running terminal keeps that list.
      try {
        notifier.persistDeadLetters(fileFor(slot));
        adopted.push({ slot, lock });
      } catch (error) {
        lock.release();
        logger.warn('A failed-notification list left by an earlier terminal could not be read', { file: fileFor(slot), error: summarizeError(error) });
      }
    }
    // The own file last: the list read so far is written there, and the files taken over are emptied.
    notifier.persistDeadLetters(fileFor(own.slot));
    for (const { slot, lock } of adopted) {
      try { unlinkSync(fileFor(slot)); } catch { /* the entries are in this terminal's file now */ }
      lock.release();
    }
  } catch (error) {
    logger.warn('Failed notifications will not survive a restart: their file could not be opened', { directory, kind, error: summarizeError(error) });
  }
  const held = own;
  return () => { held?.lock.release(); };
}

export function initialTerminalRuntimeFields(
  config: Pick<ConfigManager, 'get'>,
  providerFromModel: (model: unknown) => string,
  loadSystemPrompt: () => string,
) {
  return {
    model: config.get('provider.model') as string,
    provider: providerFromModel(config.get('provider.model')),
    debugMode: false,
    systemPrompt: loadSystemPrompt(),
    reasoningEffort: (config.get('provider.reasoningEffort') as string | undefined) ?? '',
  };
}
