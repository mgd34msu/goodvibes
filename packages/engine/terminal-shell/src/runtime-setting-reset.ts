export interface RuntimeSettingResetContext {
  readonly session: {
    readonly runtime: {
      model: string;
      reasoningEffort: string;
    };
  };
}
/**
 * Nothing to copy: the session follows `provider.model` and
 * `provider.reasoningEffort` through the model selection's own reaction to the
 * setting (model-selection-action.ts), which a reset in Settings fires like any
 * other write.
 */
export function syncRuntimeAfterSettingReset(_ctx: RuntimeSettingResetContext | undefined, _key: string, _value: unknown): void {}
