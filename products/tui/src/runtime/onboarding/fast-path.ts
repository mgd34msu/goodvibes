/**
 * fast-path.ts, minimum-steps first run.
 *
 * The full onboarding wizard is comprehensive but long (5+ steps for a brand
 * new user). The fast path gets a new user to a working session in the fewest
 * possible steps:
 *   - If the model the session will use is ready (its provider has a key, or
 *     is keyless), skip onboarding entirely, write the check marker and drop
 *     straight into a working session. ZERO steps. A key for another provider
 *     is not enough: that provider's model is offered as the first choice.
 *   - Otherwise ask exactly one question: start now on the default model, or
 *     run the full guided setup. Dismissing (Esc) starts now, so it is
 *     always skippable. The start-now copy is GENERATED from the default
 *     model's registered auth state (buildOnboardingModelCopy), so a
 *     "no API key needed" promise can only render when the provider is
 *     genuinely keyless-ready.
 *
 * The full wizard remains one keystroke away (the "Full guided setup" choice,
 * or `/onboarding` at any time). If the command context can't answer whether a
 * provider is configured (e.g. a headless/test surface), we fall back to the
 * classic behavior of opening the wizard, so nothing regresses.
 */
import {
  buildOnboardingModelCopy,
  resolveDefaultModelReadiness,
  type DefaultModelReadiness,
  type ModelProviderSource,
} from '@goodvibes-jev/engine/platform/platform/providers';
import type { CommandContext } from '../../input/command-registry.ts';
import type { SelectionItem } from '../../input/selection-modal.ts';
import { writeOnboardingCheckMarker } from './markers.ts';
import type { WriteOnboardingCheckMarkerOptions } from './types.ts';

type OnboardingMarkerShellPaths = Parameters<typeof writeOnboardingCheckMarker>[0];

export interface OnboardingFastPathDeps {
  readonly input: { openOnboardingWizard: (options: { mode: 'new'; reset: boolean }) => void };
  readonly commandContext: CommandContext;
  readonly shellPaths: OnboardingMarkerShellPaths;
  readonly render: () => void;
}

/** Read configured provider ids defensively, returns [] if the surface can't answer. */
function readConfiguredProviderIds(commandContext: CommandContext): string[] | null {
  const registry = commandContext.provider?.providerRegistry;
  if (!registry || typeof registry.getConfiguredProviderIds !== 'function') return null;
  try {
    return registry.getConfiguredProviderIds();
  } catch {
    return null;
  }
}

const MARKER_OPTIONS: WriteOnboardingCheckMarkerOptions = { source: 'command' };

/** The model the session will use: the live setting, not the boot-time copy of the config. */
function liveModelKey(commandContext: CommandContext): string {
  const live = commandContext.platform?.configManager?.get('provider.model');
  return String(live ?? commandContext.platform?.config?.provider?.model ?? '').trim();
}

/**
 * The readiness of the model the session will use, from its provider's live
 * registration state. Surfaces that cannot answer (no registry / no
 * getForModel) resolve to the honest 'unresolvable' answer.
 */
function resolveLiveReadiness(commandContext: CommandContext): DefaultModelReadiness {
  const registry = commandContext.provider?.providerRegistry;
  const source: ModelProviderSource =
    registry && typeof (registry as Partial<ModelProviderSource>).getForModel === 'function'
      ? registry
      : {
          getForModel: () => {
            throw new Error('provider registry unavailable on this surface');
          },
        };
  return resolveDefaultModelReadiness(source, liveModelKey(commandContext));
}

/** A selectable model of the first configured provider that has one, for the "use it instead" offer. */
type SelectableModel = { readonly id: string; readonly provider: string; readonly displayName: string; readonly registryKey: string };

function configuredProviderModel(commandContext: CommandContext, configured: readonly string[]): SelectableModel | null {
  const registry = commandContext.provider?.providerRegistry;
  if (!registry || typeof registry.getSelectableModels !== 'function') return null;
  let models: readonly SelectableModel[];
  try {
    models = registry.getSelectableModels();
  } catch {
    return null;
  }
  for (const provider of configured) {
    const model = models.find((candidate) => candidate.provider === provider);
    if (model) return model;
  }
  return null;
}

const isReady = (readiness: DefaultModelReadiness): boolean => readiness.kind === 'configured' || readiness.kind === 'keyless';

/**
 * Run the fast-path first-run flow. Returns nothing; side effects (wizard open,
 * marker write, modal) happen through the injected deps.
 *
 * "Ready" is printed, and first run marked done, only when the model the
 * session will use is ready. A key for some other provider is not enough: the
 * person is offered that provider's model instead.
 */
export function startOnboardingFastPath(deps: OnboardingFastPathDeps): void {
  const { input, commandContext, shellPaths, render } = deps;
  const openWizard = (): void => input.openOnboardingWizard({ mode: 'new', reset: true });

  const configured = readConfiguredProviderIds(commandContext);
  // Fall back to the classic wizard if we can't detect providers or can't prompt.
  if (configured === null || !commandContext.openSelection) {
    openWizard();
    return;
  }

  const readiness = resolveLiveReadiness(commandContext);
  if (configured.length > 0 && isReady(readiness)) {
    // The session's model works now: nothing to ask. Straight to a working session.
    writeOnboardingCheckMarker(shellPaths, MARKER_OPTIONS);
    commandContext.print?.(
      `Ready: ${readiness.modelKey} (provider ${'provider' in readiness ? readiness.provider : configured[0]}). Run /onboarding anytime for full setup.`,
    );
    render();
    return;
  }

  const startCopy = buildOnboardingModelCopy(readiness);
  const alternative = !isReady(readiness) && commandContext.completeModelSelection
    ? configuredProviderModel(commandContext, configured)
    : null;
  const items: SelectionItem[] = [
    ...(alternative
      ? [{ id: 'use-configured', label: `Use ${alternative.provider}`, detail: `Switch to ${alternative.registryKey}, from the provider whose key is set`, primaryAction: 'select' as const }]
      : []),
    { id: 'start-now', label: startCopy.headline, detail: startCopy.detail, primaryAction: 'select' },
    { id: 'full-setup', label: 'Full guided setup', detail: 'Choose provider, model, channels, and more', primaryAction: 'select' },
  ];
  commandContext.openSelection(
    'Welcome to GoodVibes: get started',
    items,
    { allowSearch: false, primaryVerbLabel: 'Choose' },
    (result) => {
      if (result?.item.id === 'full-setup') {
        openWizard();
        return;
      }
      if (result?.item.id === 'use-configured' && alternative) {
        const effort = commandContext.platform?.configManager?.get('provider.reasoningEffort');
        commandContext.completeModelSelection?.({
          model: { id: alternative.id, provider: alternative.provider, displayName: alternative.displayName, registryKey: alternative.registryKey },
          effort: typeof effort === 'string' ? effort : '',
        });
        if (isReady(resolveLiveReadiness(commandContext))) {
          writeOnboardingCheckMarker(shellPaths, MARKER_OPTIONS);
          commandContext.print?.(`Ready: ${alternative.registryKey}. Run /onboarding anytime for full setup.`);
        } else {
          commandContext.print?.(`${alternative.registryKey} is not ready yet. Pick a model with /model, or run /onboarding for full setup.`);
        }
        render();
        return;
      }
      // "Add an API key to start": the key is typed here, masked, and stored
      // for this user in every project (the same entry as /secrets set --user <VAR>).
      const keyVar = readiness.kind === 'needs-key' ? readiness.authEnvVars[0] : undefined;
      if (result?.item.id === 'start-now' && keyVar && commandContext.executeCommand) {
        writeOnboardingCheckMarker(shellPaths, MARKER_OPTIONS);
        void commandContext.executeCommand('secrets', ['set', '--user', keyVar])
          .catch((error: unknown) => commandContext.print?.(`Could not open the key entry for ${keyVar}: ${error instanceof Error ? error.message : String(error)}. Run /secrets set --user ${keyVar} to add it.`))
          .finally(render);
        return;
      }
      // Start now (or dismissed): mark first-run done and drop into a working
      // session on the configured model. The status line reuses the generated
      // copy so it can never promise readiness the registration state does not prove.
      writeOnboardingCheckMarker(shellPaths, MARKER_OPTIONS);
      commandContext.print?.(
        `${startCopy.detail}. Add a provider key anytime with /provider, or run /onboarding for full setup.`,
      );
      render();
    },
  );
}
