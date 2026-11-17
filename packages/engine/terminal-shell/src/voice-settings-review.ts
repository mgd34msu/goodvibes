import { isDaemonOwnedConfigKey, isProtectedConfigValue } from '@goodvibes-jev/engine/platform/platform/config';

/**
 * A portable copy of this machine's voice settings: always-speak
 * (`ui.voiceEnabled`), speech output (`tts.*`) and wake-word listening
 * (`voice.wake.*`). Credentials and daemon-owned keys (`voice.local.*`) are
 * never carried; `/voice bundle import` applies the rest as one update.
 */
export interface VoiceBundle {
  readonly version: 2;
  readonly exportedAt: number;
  readonly settings: Readonly<Record<string, unknown>>;
}

/** A setting a voice bundle carries. */
export function isVoiceBundleKey(key: string): boolean {
  if (key !== 'ui.voiceEnabled' && !key.startsWith('tts.') && !key.startsWith('voice.wake.')) return false;
  return !isDaemonOwnedConfigKey(key) && !isProtectedConfigValue(key);
}

/** The bundle a file holds, or why it is not one. Version 1 files carried only `enabled`. */
export function readVoiceBundle(value: unknown): { readonly bundle: VoiceBundle } | { readonly problem: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problem: 'That file is not a voice bundle (expected a JSON object).' };
  const b = value as Record<string, unknown>;
  const exportedAt = b['exportedAt'];
  if (typeof exportedAt !== 'number' || Number.isNaN(new Date(exportedAt).getTime())) {
    return { problem: 'That file is not a voice bundle (exportedAt is missing or not a time).' };
  }
  if (b['version'] === 1) {
    if (typeof b['enabled'] !== 'boolean') return { problem: 'That version 1 voice bundle has no enabled flag.' };
    return { bundle: { version: 2, exportedAt, settings: { 'ui.voiceEnabled': b['enabled'] } } };
  }
  if (b['version'] !== 2) return { problem: `That voice bundle is version ${String(b['version'])}; this build reads versions 1 and 2.` };
  const settings = b['settings'];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { problem: 'That voice bundle has no settings object.' };
  const foreign = Object.keys(settings).filter((key) => !isVoiceBundleKey(key));
  if (foreign.length > 0) return { problem: `That voice bundle carries settings that are not voice settings: ${foreign.join(', ')}.` };
  return { bundle: { version: 2, exportedAt, settings: settings as Record<string, unknown> } };
}

export function inspectVoiceBundle(value: unknown): string {
  const read = readVoiceBundle(value);
  if ('problem' in read) return read.problem;
  const entries = Object.entries(read.bundle.settings);
  return [
    'Voice Bundle',
    `  exportedAt: ${new Date(read.bundle.exportedAt).toISOString()}`,
    `  settings: ${entries.length}`,
    ...entries.map(([key, setting]) => `    ${key} = ${JSON.stringify(setting)}`),
  ].join('\n');
}
