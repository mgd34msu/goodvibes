import type { ConfigSetting } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ModelPickerTarget as PlatformModelTarget } from './model-picker-types.js';
export type ModelPickerTarget = Exclude<PlatformModelTarget, 'embeddings'>;
export type ModelPickerLaunch =
  | {
      readonly flow: 'providerModel';
      readonly target: ModelPickerTarget;
    }
  | {
      readonly flow: 'model';
      readonly target: ModelPickerTarget;
    };
/**
 * Map config keys to the shared provider/model picker flows.
 */
export function modelPickerLaunchForKey(key: string): ModelPickerLaunch | null {
  if (key === 'provider.model') return { flow: 'providerModel', target: 'main' };
  if (key === 'helper.globalProvider') return { flow: 'providerModel', target: 'helper' };
  if (key === 'helper.globalModel') return { flow: 'model', target: 'helper' };
  if (key === 'tools.llmProvider') return { flow: 'providerModel', target: 'tool' };
  if (key === 'tools.llmModel') return { flow: 'model', target: 'tool' };
  if (key === 'tts.llmProvider') return { flow: 'providerModel', target: 'tts' };
  if (key === 'tts.llmModel') return { flow: 'model', target: 'tts' };
  return null;
}
export function roundToPrecision(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
export function getNumericAdjustmentMeta(setting: ConfigSetting): {
  step: number;
  min?: number | undefined;
  max?: number | undefined;
  precision: number;
} {
  if (setting.key === 'tts.speed') {
    // Speed multiplier, 0.1 increments across the schema's own supported range
    // (see the key's numRange in the SDK config schema).
    return { step: 0.1, min: 0.25, max: 4, precision: 1 };
  }
  return { step: 1, precision: 0 };
}
/**
 * Parse a committed number-setting edit buffer, money field or not: SDK
 * 2.0.5 removed the major/minor conversion these keys used to need, so a
 * money setting's stored value is now the plain number a person typed, same
 * as any other number setting. Returns null for anything unparseable; the
 * SDK's own config-set codec (`coerceSchemaValue`) tolerates a leading
 * currency symbol or thousands grouping on the write path itself.
 */
export function parseNumberEditBuffer(buffer: string): number | null {
  const parsed = Number(buffer);
  return Number.isNaN(parsed) ? null : parsed;
}

export function cycleSettingChoice<Value>(values: readonly Value[], current: Value, direction: 'left' | 'right'): Value | undefined {
  if (values.length === 0) return undefined;
  const index = Math.max(0, values.indexOf(current));
  return values[(index + (direction === 'right' ? 1 : -1) + values.length) % values.length];
}
export function adjustedSettingValue(
  setting: ConfigSetting,
  current: unknown,
  direction: 'left' | 'right',
  step: number,
): { readonly value: unknown } | undefined {
  if (setting.type === 'boolean') return { value: direction === 'right' };
  if (setting.type === 'enum' && setting.enumValues && setting.enumValues.length > 0)
    return { value: cycleSettingChoice(setting.enumValues, String(current), direction) };
  if (setting.type !== 'number') return undefined;
  const number = Number(current ?? 0);
  if (!Number.isFinite(number)) return undefined;
  const adjustment = getNumericAdjustmentMeta(setting);
  const delta = adjustment.step * step;
  const rounded = roundToPrecision(number + (direction === 'right' ? delta : -delta), adjustment.precision);
  const value = Math.min(adjustment.max ?? rounded, Math.max(adjustment.min ?? rounded, rounded));
  return setting.validate && !setting.validate(value) ? undefined : { value };
}
