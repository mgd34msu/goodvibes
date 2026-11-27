import type { ModalSurfaceRegistry } from './modal-surface-registry.ts';
import type { ResolvedBuiltinViewDeps } from './view-deps.ts';
import type { ConfigModalSurface, ConfigModalView } from '../input/config-modal-types.ts';
import { pairingOriginUsesStableHost, refreshStableHostInputs } from '@goodvibes/engine/platform/platform/pairing';
import { createKeybindingsModalSurface } from './modals/keybindings-modal.ts';

/**
 * Register the config-modal surfaces and the old names that open them. Called
 * once at startup from createShellViews (builtin-views.ts). For each surface
 * this does two things:
 *   1. registerModalSurface, the data + actions the config-modal host renders.
 *   2. registerModalRedirect, so deep links, notifications and any
 *      alias still resolve to the modal (views.ts consults these).
 *
 * Who may sign in is in the Permissions and safety place (terminal-shell
 * places/safety-place.ts): its form takes a password on a hidden line.
 */
export function registerBuiltinModals(
  manager: ModalSurfaceRegistry,
  deps: ResolvedBuiltinViewDeps,
): void {
  const ui = deps.uiServices;
  // Work is a place (terminal-shell places/work-place.ts); view-openers.ts opens it by the old work, planning and to-do screens' names.

  // Providers, their sign-ins and the services are the Models and providers place (terminal-shell
  // places/models-place.ts); view-openers.ts opens it by the old screens' names.

  // ── Security & Governance ────────────────────────────────────────────────────
  // Settings sync is the Devices and network place's Settings sync tab (terminal-shell places/devices-place.ts).
  // Security, the policy bundles and the sandbox are the Permissions and safety place (terminal-shell
  // places/safety-place.ts); view-openers.ts opens it by the old screens' names.

  // ── Ecosystem & Governance ───────────────────────────────────────────────────
  // The marketplace is the Marketplace and Installed tabs of Tools and extensions (terminal-shell places/tools-place.ts);
  // view-openers.ts opens it by the old screen's name.

  // plugins/hooks/knowledge deps are wired at bootstrap in production
  // (bootstrap-shell.ts) but may be absent in a partially-wired context (e.g. a
  // release-gate harness), register a degraded placeholder rather than throw,
  // so the surface + redirect always resolve (the "always register, degrade
  // honestly" charter pattern).
  // Skills, plugins and hooks (with the trace of which hooks ran) are tabs of Tools and extensions
  // (terminal-shell places/tools-place.ts, tools-skills-entries.ts): no screen of their own.

  // Memory and knowledge is a place (terminal-shell places/memory-place.ts); view-openers.ts opens it by these names.


  manager.registerModalSurface(createKeybindingsModalSurface({
    toolRegistry: deps.toolRegistry,
    providerRegistry: deps.providerRegistry,
    keybindingsManager: ui.shell.keybindingsManager,
  }));
  manager.registerModalRedirect('docs', 'keybindings-modal');

  // The pairing link's host ladder needs two slow probes (Tailscale, the `.local` lookup). Run them in the background now,
  // only when the link will use the ladder, so Pair something (Devices and network) already has the answer.
  if (pairingOriginUsesStableHost(deps.configManager)) void refreshStableHostInputs();

  // Paired devices are the Devices and network place (terminal-shell places/devices-place.ts).


  // The retired 'sessions' view folds into the EXISTING session-picker modal
  // (no new config-modal surface); the redirect is a plain hand-off, moved here
  // from the deleted ecosystem bridge.
  manager.registerModalRedirect('sessions', 'sessionPicker');
}

/** A minimal config-modal surface that renders an honest "not wired" degraded
 *  state, used when a group-B surface's bootstrap dependency is absent. */
function unwiredSurface(name: string, title: string, reason: string): ConfigModalSurface {
  return {
    name,
    title,
    buildView: (): ConfigModalView => ({ title, degraded: reason, tabs: [{ id: 'main', label: title, rows: [] }] }),
  };
}

