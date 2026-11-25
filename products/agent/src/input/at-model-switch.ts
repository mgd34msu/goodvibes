/**
 * at-model-switch.ts, the `@model:<id>` switch a person can type at the start
 * or the end of a composer message.
 *
 * `@model:opus summarize this` and `summarize this @model:opus` switch the
 * model and send "summarize this". Only a whole token at either end counts, so
 * text that merely contains `@model:` (an `scp user@model:/srv` line, a pasted
 * config) is sent as written. The composer is the only caller: forms and speech
 * submit their text unchanged.
 *
 * An id that names no model is reported and left in the message, so nothing
 * the person wrote disappears on the way to the model.
 */

import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import { splitAtModelDirectives } from '@goodvibes/engine/terminal-shell/submission-router';

export interface AtModelSwitchOptions {
  readonly providerRegistry: Pick<ProviderRegistry, 'setCurrentModel' | 'getCurrentModel'>;
  readonly configManager: Pick<ConfigManager, 'setRuntimeOverride'>;
  /** Applied for each switch that took, so the surface's own labels follow. */
  readonly onModelChanged: (model: { readonly id: string; readonly provider: string }) => void;
  /** One line per switch, what it became, or that the id named nothing. */
  readonly notify: (message: string) => void;
}

/** Switch to `modelId`; false when the id names no model (nothing changed). */
function switchModel(modelId: string, options: AtModelSwitchOptions): boolean {
  let def: ReturnType<AtModelSwitchOptions['providerRegistry']['getCurrentModel']>;
  try {
    options.providerRegistry.setCurrentModel(modelId);
    def = options.providerRegistry.getCurrentModel();
  } catch {
    options.notify(`[Model] Unknown model: ${modelId}. The text was sent as written.`);
    return false;
  }
  // The switch is live from here, so a later failure is not "unknown model".
  try {
    options.onModelChanged({ id: def.id, provider: def.provider });
    // This conversation's own model: the shared default every program starts from is not touched.
    options.configManager.setRuntimeOverride('provider.model', def.registryKey);
    options.notify(`[Model] Switched this conversation to ${def.displayName} (${def.provider}) via @model:`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.notify(`[Model] Switched to ${def.displayName} (${def.provider}) for this session, but saving or showing the change failed: ${reason}`);
  }
  return true;
}

/**
 * Apply a leading and a trailing `@model:` token of typed composer text and
 * return the text with each token that switched removed.
 *
 * Returns the input unchanged when there is none, which is the common case.
 */
export function applyAtModelSwitches(text: string, options: AtModelSwitchOptions): string {
  // The one reading of the token, shared with the TUI (terminal-shell submission-router).
  return splitAtModelDirectives(text, (model) => switchModel(model, options)).text;
}
