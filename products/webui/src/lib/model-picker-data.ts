/**
 * What the composer's model menu (views/chat/ModelPicker.tsx) is built from:
 * one provider's row from the daemon's providers and models lists, and the
 * sentence `models.refresh`'s answer is said in.
 */
import { asRecord } from './object';
import { deriveProviderStatus } from './provider-status';
import type { ModelOption, ProviderOption } from './provider-models';
import type { PickerModel, PickerProvider } from '../views/chat/ModelPicker';

/** The effort levels a model offers to choose from (two or more), from its models.list entry. */
function effortLevelsOf(value: unknown): string[] {
  const levels = asRecord(asRecord(value).reasoningOptions).levels;
  const list = Array.isArray(levels) ? levels.filter((level): level is string => typeof level === 'string' && level.length > 0) : [];
  return list.length > 1 ? list : [];
}

/**
 * One provider as the menu shows it. Only models that can hold a conversation
 * are listed (`textWork` from the model catalog; `other` is left out, a model
 * the catalog does not describe is kept and marked), as the terminal's Main
 * chat tab does. A provider signed in only by a subscription is connected from
 * a terminal: its action is the command to copy.
 */
export function pickerProviderOf(provider: ProviderOption, options: readonly ModelOption[]): PickerProvider {
  const status = deriveProviderStatus(provider.value);
  const modelList = asRecord(asRecord(provider.value).modelList);
  const models: PickerModel[] = [];
  for (const option of options) {
    const value = asRecord(option.value);
    const textWork = typeof value.textWork === 'string' ? value.textWork : 'unknown';
    if (textWork === 'other') continue;
    models.push({
      registryKey: option.registryKey,
      label: option.label,
      providerId: option.providerId,
      efforts: provider.id === 'decision-router' ? [] : effortLevelsOf(value),
      kindUnknown: textWork !== 'text',
    });
  }
  const subscriptionOnly = status.routes.length > 0 && status.routes.every((route) => route.route === 'subscription-oauth');
  const signInId = status.routes.find((route) => route.providerId)?.providerId ?? provider.id;
  return {
    id: provider.id,
    label: provider.label,
    connected: status.configured,
    models,
    ...(typeof modelList.listedAt === 'number' ? { listedAt: modelList.listedAt } : {}),
    ...(typeof modelList.error === 'string' ? { listError: modelList.error } : {}),
    connect: subscriptionOnly ? { kind: 'command', command: `/provider sign-in ${signInId}` } : { kind: 'settings' },
  };
}

/** One provider's line in models.refresh's answer. */
interface RefreshReport {
  readonly label: string;
  readonly models: number;
  readonly source: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly error?: string | undefined;
  readonly notAsked?: boolean | undefined;
}

/** What a refresh did, in the words the terminal's /model refresh uses. */
export function modelRefreshSentence(reports: readonly RefreshReport[]): string {
  const lines = reports.filter((report) => report.notAsked !== true).map((report) => {
    if (report.error) return `${report.label}: could not be read (${report.error}); ${report.models} models from ${report.source === 'cache' ? 'its last list' : 'the built-in catalog'}`;
    const changes = [report.added.length > 0 ? `${report.added.length} new` : '', report.removed.length > 0 ? `${report.removed.length} retired` : ''].filter(Boolean);
    return `${report.label}: ${report.models} models found${changes.length > 0 ? ` (${changes.join(', ')})` : ''}`;
  });
  return lines.length > 0 ? `${lines.join('. ')}.` : 'No connected provider lists its own models; the model catalog was checked.';
}
