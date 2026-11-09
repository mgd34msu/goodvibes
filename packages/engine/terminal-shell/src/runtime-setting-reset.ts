import type { ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import { servingEffortForLevel, toEffortModel } from '@goodvibes-jev/engine/platform/platform/providers/reasoning-effort-surface';
export interface RuntimeSettingResetContext {
  readonly session: {
    readonly runtime: {
      model: string;
      reasoningEffort: string;
    };
  };
  readonly provider?:
    | {
        readonly providerRegistry?:
          | {
              getCurrentModel?(): ModelDefinition | null | undefined;
            }
          | undefined;
      }
    | undefined;
}
export function syncRuntimeAfterSettingReset(ctx: RuntimeSettingResetContext | undefined, key: string, value: unknown): void {
  if (!ctx) return;
  if (key === 'provider.model') ctx.session.runtime.model = String(value);
  if (key === 'provider.reasoningEffort') {
    // config holds the REQUESTED level; the session holds the EFFECTIVE one for
    // whichever model is serving, so the reset value is resolved rather than
    // copied straight across. A context with no reachable provider registry
    // (a surface that routes only through the provider API) stores the reset
    // value unresolved rather than failing the whole reset.
    const serving = ctx.provider?.providerRegistry?.getCurrentModel?.();
    ctx.session.runtime.reasoningEffort = serving
      ? (servingEffortForLevel(String(value), toEffortModel(serving)).effective ?? '')
      : String(value);
  }
}
