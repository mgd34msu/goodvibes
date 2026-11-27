/**
 * The one choice and the one wording every capability that applies settings from a file or another machine uses
 * (startup.transfer-import, bundle.import, presets.load, voice.import, settings-sync.pull, settings-sync.resolve): a
 * setting whose incoming value loosens a protection is held back, shown with its present and incoming value, and
 * applied only when the caller chose to bring security settings in too. That choice is a loosening act of its own
 * (`risk: 'loosens-a-protection'`), so the person is asked it once and a model's or another caller's call is put to
 * the owner, opening on No. The split itself is support/setup-transfer.ts `splitIncomingSettings`.
 */
import { describeHeldBackSettings, type IncomingSettingChange } from '../../support/setup-transfer.js';
import type { ActionValues, InputDescription } from '../types.js';

/** The choice: leave settings that loosen a protection as they are (the default), or bring them in too. */
export function incomingSecurityInput(bringWords = 'Bring them in too'): InputDescription {
  return {
    id: 'security', label: 'Security settings', help: 'Settings that loosen a protection: what runs unasked, what this computer exposes, where data and secrets are kept',
    kind: 'choice', choices: [
      { value: 'no', label: 'Leave them as they are' },
      { value: 'yes', label: bringWords, help: 'A setting that loosens a protection is then changed too.', risk: 'loosens-a-protection' },
    ],
    required: { default: 'no', defaultMeans: 'leave them as they are' }, typed: { flag: '--include-security', switchOn: 'yes' },
  };
}

/** Whether the run chose to bring security settings in too. */
export function bringsSecurity(values: ActionValues): boolean {
  return values.security === 'yes';
}

/** The lines naming what was held back, each with its present and incoming value; nothing when nothing was. */
export function heldBackLines(heldBack: readonly IncomingSettingChange[], again: string): string[] {
  if (heldBack.length === 0) return [];
  return [`Held back: ${heldBack.length} setting(s) that loosen a protection, left as they are (${again}):`, ...describeHeldBackSettings(heldBack)];
}
