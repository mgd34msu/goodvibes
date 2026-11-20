import { SETTINGS_CHOICE_ACTIONS, type SettingsChoiceAction } from '@goodvibes-jev/engine/terminal-shell/settings-choice-actions';
/**
 * settings-modal-activation, pure action helpers for SettingsModal.
 *
 * These functions encapsulate the two activation/interaction operations:
 *   - activateSelected: toggle boolean, cycle enum, enter edit mode, launch pickers
 *   - handleSubscriptionLogoutKey: route a keypress through the logout confirm gate
 *
 * Each function takes its dependencies as explicit arguments rather than
 * accessing class-level state directly, following the same pattern as
 * settings-modal-reset.ts and settings-modal-mutations.ts.
 */

import { handleConfirmInput } from '../views/confirm-state.ts';
import type { FlagEntry, McpEntry, SettingEntry, SubscriptionEntry } from './settings-modal-types.ts';
import { buildMcpEntries, buildSubscriptionEntries } from './settings-modal-data.ts';
import { modelPickerLaunchForKey } from '@goodvibes-jev/engine/terminal-shell/settings-behavior';
import { PAYMENTS_CARDS_ROW_KEY } from '@goodvibes-jev/engine/terminal-shell/payments-settings';
import { listSettingEditText } from './settings-modal-lists.ts';
import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import type { SubscriptionManager } from '@goodvibes-jev/engine/platform/platform/config';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ServiceInspectionQuery } from '@/runtime/index.ts';
import type { ModelPickerTarget } from './model-picker.ts';

// ---------------------------------------------------------------------------
// activateSelected
// ---------------------------------------------------------------------------

export interface ActivateSelectedContext {
  readonly currentCategory: string;
  readonly configManager: { get(key: ConfigKey): unknown } | null;
  getSelectedMcp(): McpEntry | null;
  getSelectedSubscription(): SubscriptionEntry | null;
  getSelected(): SettingEntry | null;
  setValue(key: ConfigKey, value: unknown): void;
  setHostValue?(key: string, value: boolean): void;
  setEditingMode(value: boolean): void;
  setEditBuffer(value: string): void;
  setMcpAllowAllConfirmationTarget(value: string | null): void;
  setSubscriptionLogoutConfirmationTarget(value: string | null): void;
  setPendingSettingsPickerAction(value: 'tts-provider' | 'tts-voice' | 'theme' | SettingsChoiceAction | 'payments-cards' | null): void;
  setPendingModelPickerTarget(value: ModelPickerTarget | null): void;
  setPendingProviderModelPickerTarget(value: ModelPickerTarget | null): void;
}

export function activateSelected(ctx: ActivateSelectedContext): void {
  if (ctx.currentCategory === 'mcp') {
    const entry = ctx.getSelectedMcp();
    if (!entry) return;
    ctx.setEditingMode(true);
    ctx.setEditBuffer(entry.trustMode);
    ctx.setMcpAllowAllConfirmationTarget(null);
    return;
  }

  if (ctx.currentCategory === 'subscriptions') {
    const entry = ctx.getSelectedSubscription();
    if (!entry) return;
    if (entry.state === 'active' || entry.state === 'pending') {
      // First press: arm the confirm gate. Subsequent key handling routes
      // through handleSubscriptionLogoutKey() before normal dispatch.
      ctx.setSubscriptionLogoutConfirmationTarget(entry.provider);
    }
    return;
  }

  const entry = ctx.getSelected();
  if (!entry || !ctx.configManager) return;

  if (entry.kind === 'host') {
    ctx.setHostValue?.(entry.setting.key, !entry.currentValue);
    return;
  }
  if (entry.metadataUnavailable) return;
  const { setting } = entry;

  const choice = SETTINGS_CHOICE_ACTIONS[setting.key];
  if (choice) { ctx.setPendingSettingsPickerAction(choice); return; }
  // The cards row lists the daemon's cards and starts /payments add-card.
  if (setting.key === PAYMENTS_CARDS_ROW_KEY) { ctx.setPendingSettingsPickerAction('payments-cards'); return; }

  // Delegate provider/model picker settings to the model picker UI
  if (setting.key === 'tts.provider') {
    ctx.setPendingSettingsPickerAction('tts-provider');
    return;
  }
  if (setting.key === 'tts.voice') {
    ctx.setPendingSettingsPickerAction('tts-voice');
    return;
  }
  // The theme row opens a picker with live preview instead of cycling values.
  if (setting.key === 'display.theme') {
    ctx.setPendingSettingsPickerAction('theme');
    return;
  }

  const pickerLaunch = modelPickerLaunchForKey(setting.key);
  if (pickerLaunch !== null) {
    if (pickerLaunch.flow === 'providerModel') {
      ctx.setPendingProviderModelPickerTarget(pickerLaunch.target);
    } else {
      ctx.setPendingModelPickerTarget(pickerLaunch.target);
    }
    return;
  }

  if (setting.type === 'boolean') {
    const newVal = !entry.currentValue;
    ctx.setValue(setting.key as ConfigKey, newVal);
  } else if (setting.type === 'enum' && setting.enumValues) {
    const idx = setting.enumValues.indexOf(entry.currentValue as string);
    const nextIdx = (idx + 1) % setting.enumValues.length;
    ctx.setValue(setting.key as ConfigKey, setting.enumValues[nextIdx]);
  } else if (setting.type === 'object') {
    // Object-typed keys (e.g. pricing.modelPrices) edit as JSON: seed the
    // buffer with the current value's JSON so the edit starts from truth.
    ctx.setEditingMode(true);
    ctx.setEditBuffer(JSON.stringify(entry.currentValue ?? {}));
  } else if (setting.type === 'string' || setting.type === 'number') {
    // Enter inline edit mode; a list row starts from text that parses back to the same list.
    ctx.setEditingMode(true);
    ctx.setEditBuffer(listSettingEditText(setting.key as ConfigKey, entry.currentValue) ?? String(entry.currentValue ?? ''));
  }
}

// ---------------------------------------------------------------------------
// handleSubscriptionLogoutKey
// ---------------------------------------------------------------------------

export interface HandleSubscriptionLogoutKeyContext {
  readonly subscriptionLogoutConfirmationTarget: string | null;
  readonly subscriptionManager: SubscriptionManager | null;
  readonly serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'> | null;
  setSubscriptionEntries(entries: SubscriptionEntry[]): void;
  setSubscriptionLogoutConfirmationTarget(value: string | null): void;
  /** Called when the sign-out has finished removing the tokens, so the list is drawn again. */
  requestRender?(): void;
}

export function handleSubscriptionLogoutKey(
  ctx: HandleSubscriptionLogoutKeyContext,
  key: string,
): 'confirmed' | 'cancelled' | 'absorbed' | 'inactive' {
  const target = ctx.subscriptionLogoutConfirmationTarget;
  if (!target) return 'inactive';
  const confirmState = { subject: target, label: target };
  const result = handleConfirmInput(confirmState, key);
  if (result === 'confirmed') {
    // The record leaves the file at once; the tokens leave the secret store when its write finishes.
    const manager = ctx.subscriptionManager;
    void manager?.logout(target).catch((error: unknown) => {
      logger.warn('Signed out, but the sign-in tokens could not be removed from the secret store', { provider: target, error: summarizeError(error) });
    }).finally(() => {
      ctx.setSubscriptionEntries(buildSubscriptionEntries(manager, ctx.serviceRegistry));
      ctx.requestRender?.();
    });
    ctx.setSubscriptionEntries(buildSubscriptionEntries(manager, ctx.serviceRegistry));
    ctx.setSubscriptionLogoutConfirmationTarget(null);
  } else if (result === 'cancelled') {
    ctx.setSubscriptionLogoutConfirmationTarget(null);
  }
  // 'absorbed': confirm remains pending
  return result;
}

// Re-export FlagEntry so callers need not import from two modules.
export type { FlagEntry };
