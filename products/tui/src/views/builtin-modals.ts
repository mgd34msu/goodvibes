import { createNativeWorkLedgerModalSurface } from './modals/native-work-ledger-modal.ts';
import type { ModalSurfaceRegistry } from './modal-surface-registry.ts';
import type { ResolvedBuiltinViewDeps } from './view-deps.ts';
import type { ConfigModalSurface, ConfigModalView } from '../input/config-modal-types.ts';
import { createProviderRuntimeInspectionQuery } from '@/runtime/index.ts';
import { createRuntimeProviderApi } from '@/runtime/index.ts';
import { copyToClipboard } from '../utils/clipboard.ts';
import { ensurePublicBaseUrl, pairingOriginUsesStableHost, refreshStableHostInputs } from '@goodvibes-jev/engine/platform/platform/pairing';
import { availablePairingOffers, mintPairingHandoff, defaultPairingTokenName } from '@goodvibes-jev/engine/platform/platform/pairing';
import { probePairingTailscale, runPairingTailscaleServe } from '../core/pairing-tailscale-gateway.ts';
// ── Providers & Connectivity + Security subset ────────────────────────────────
import { createServicesModalSurface } from './modals/services-modal.ts';
import { createSubscriptionModalSurface } from './modals/subscription-modal.ts';
import { createRemoteModalSurface } from './modals/remote-modal.ts';
import { createSettingsSyncModalSurface } from './modals/settings-sync-modal.ts';
import { createProviderHealthModalSurface } from './modals/provider-health-modal.ts';
import { createLocalAuthModalSurface } from './modals/local-auth-modal.ts';
import { createSandboxModalSurface } from './modals/sandbox-modal.ts';
// ── Ecosystem & Governance ─────────────────────────────────────────────────
import { createMarketplaceModalSurface } from './modals/marketplace-modal.ts';
import { createPluginsModalSurface } from './modals/plugins-modal.ts';
import { createSkillsModalSurface } from './modals/skills-modal.ts';
import { createHooksModalSurface } from './modals/hooks-modal.ts';
import { createSecurityModalSurface } from './modals/security-modal.ts';
import { createPolicyModalSurface } from './modals/policy-modal.ts';
import { createKnowledgeModalSurface } from './modals/knowledge-modal.ts';
import { createMemoryModalSurface, type MemoryModalDeps } from './modals/memory-modal.ts';
import { createMemoryConsolidationGateway } from './memory-consolidation-gateway.ts';
import { createWorkPlanModalSurface } from './modals/work-plan-modal.ts';
import { createKeybindingsModalSurface } from './modals/keybindings-modal.ts';
import { createPairingModalSurface, type PairingConnectionRequest, type PairingModalConnectionInfo } from './modals/pairing-modal.ts';
import { createDevicesModalSurface } from './modals/devices-modal.ts';
import { createPlanningModalSurface } from './modals/planning-modal.ts';

/**
 * Register the config-modal surfaces and the old names that open them. Called
 * once at startup from createShellViews (builtin-views.ts). For each surface
 * this does two things:
 *   1. registerModalSurface, the data + actions the config-modal host renders.
 *   2. registerModalRedirect, so `/panel open <old-id>`, notifications and any
 *      alias still resolve to the modal (views.ts consults these).
 *
 * `openMaskedEntry` opens the local-auth password prompt (a kit modal), which
 * is how the Local Auth modal's add-user and rotate-password actions keep the
 * password out of argv, history and the transcript.
 */
export function registerBuiltinModals(
  manager: ModalSurfaceRegistry,
  deps: ResolvedBuiltinViewDeps,
  openMaskedEntry: (kind: 'add-user' | 'rotate-password', username?: string) => void,
): void {
  const ui = deps.uiServices;
  manager.registerModalSurface(createNativeWorkLedgerModalSurface(deps.nativeWorkLedgerSelection ?? (() => ({ available: false, identity: 'unwired', reason: 'No authenticated native work host selected.' }))));
  manager.registerModalRedirect('work', 'native-work-ledger-modal');

  // ── Providers & Connectivity ─────────────────────────────────────────────────
  manager.registerModalSurface(createServicesModalSurface(deps.serviceRegistry, deps.subscriptionManager));
  manager.registerModalRedirect('services', 'services-modal');

  manager.registerModalSurface(createSubscriptionModalSurface(deps.serviceRegistry, deps.subscriptionManager));
  manager.registerModalRedirect('subscription', 'subscription-modal');

  manager.registerModalSurface(createRemoteModalSurface(ui.readModels.remote));
  manager.registerModalRedirect('remote', 'remote-modal');

  manager.registerModalSurface(createBuiltinProviderHealthModalSurface(deps));
  manager.registerModalRedirect('provider-health', 'providers-modal');
  manager.registerModalRedirect('providers', 'providers-modal');
  manager.registerModalRedirect('accounts', 'providers-modal');

  // ── Security & Governance ────────────────────────────────────────────────────
  manager.registerModalSurface(createSettingsSyncModalSurface(deps.configManager));
  manager.registerModalRedirect('settings-sync', 'settings-sync-modal');

  manager.registerModalSurface(createLocalAuthModalSurface(deps.localUserAuthManager, openMaskedEntry));
  manager.registerModalRedirect('local-auth', 'local-auth-modal');

  manager.registerModalSurface(createSandboxModalSurface(deps.configManager, deps.sandboxSessionRegistry, deps.requestRender));
  manager.registerModalRedirect('sandbox', 'sandbox-modal');

  // ── Ecosystem & Governance ───────────────────────────────────────────────────
  manager.registerModalSurface(createMarketplaceModalSurface({
    readModel: ui.readModels.marketplace,
    ecosystemPaths: {
      cwd: ui.environment.shellPaths.workingDirectory,
      homeDir: ui.environment.shellPaths.homeDirectory,
      projectCatalogRoot: ui.environment.shellPaths.resolveProjectPath('tui', 'ecosystem'),
      userCatalogRoot: ui.environment.shellPaths.resolveUserPath('tui', 'ecosystem'),
    },
  }));
  manager.registerModalRedirect('marketplace', 'marketplace-modal');

  // plugins/hooks/knowledge deps are wired at bootstrap in production
  // (bootstrap-shell.ts) but may be absent in a partially-wired context (e.g. a
  // release-gate harness), register a degraded placeholder rather than throw,
  // so the surface + redirect always resolve (the "always register, degrade
  // honestly" charter pattern).
  manager.registerModalSurface(deps.pluginManager
    ? createPluginsModalSurface({ pluginManager: deps.pluginManager })
    : unwiredSurface('plugins-modal', 'Plugins', 'Plugin manager not wired into this session.'));
  manager.registerModalRedirect('plugins', 'plugins-modal');

  manager.registerModalSurface(createSkillsModalSurface({
    shellPaths: {
      workingDirectory: ui.environment.shellPaths.workingDirectory,
      homeDirectory: ui.environment.shellPaths.homeDirectory,
    },
    ecosystemPaths: {
      cwd: ui.environment.shellPaths.workingDirectory,
      homeDir: ui.environment.shellPaths.homeDirectory,
      projectCatalogRoot: ui.environment.shellPaths.resolveProjectPath('tui', 'ecosystem'),
      userCatalogRoot: ui.environment.shellPaths.resolveUserPath('tui', 'ecosystem'),
    },
  }));
  manager.registerModalRedirect('skills', 'skills-modal');

  manager.registerModalSurface(deps.hookDispatcher && deps.hookWorkbench && deps.hookActivityTracker
    ? createHooksModalSurface({ hookDispatcher: deps.hookDispatcher, hookWorkbench: deps.hookWorkbench, hookActivityTracker: deps.hookActivityTracker })
    : unwiredSurface('hooks-modal', 'Hooks', 'Hook dispatcher/workbench not wired into this session.'));
  manager.registerModalRedirect('hooks', 'hooks-modal');

  manager.registerModalSurface(createSecurityModalSurface({ readModel: ui.readModels.security }));
  manager.registerModalRedirect('security', 'security-modal');

  manager.registerModalSurface(createPolicyModalSurface({ policyRuntimeState: deps.policyRuntimeState }));
  manager.registerModalRedirect('policy', 'policy-modal');

  manager.registerModalSurface(deps.knowledgeApi
    ? createKnowledgeModalSurface({ knowledgeApi: deps.knowledgeApi })
    : unwiredSurface('knowledge-modal', 'Knowledge', 'Knowledge API not wired into this session.'));
  manager.registerModalRedirect('knowledge', 'knowledge-modal');

  manager.registerModalSurface(createMemoryModalSurface({
    memoryRegistry: deps.memoryRegistry as MemoryModalDeps['memoryRegistry'],
    // Lazily resolved, a fresh factory call per Proposals-tab fetch, exactly
    // like the Fleet gateway (fleet-gateway.ts), so a daemon that comes up
    // AFTER this session started is still reachable on the next refresh.
    resolveConsolidationGateway: () => createMemoryConsolidationGateway({
      configManager: deps.configManager,
      homeDirectory: ui.environment.shellPaths.homeDirectory,
    }),
  }));
  manager.registerModalRedirect('memory', 'memory-modal');

  manager.registerModalSurface(createWorkPlanModalSurface({ workPlan: deps.workPlan }));
  manager.registerModalRedirect('work-plan', 'work-plan-modal');

  manager.registerModalSurface(createKeybindingsModalSurface({
    toolRegistry: deps.toolRegistry,
    providerRegistry: deps.providerRegistry,
    keybindingsManager: ui.shell.keybindingsManager,
  }));
  manager.registerModalRedirect('docs', 'keybindings-modal');

  const tailscaleGatewayDeps = { configManager: deps.configManager, homeDirectory: ui.environment.shellPaths.homeDirectory };
  // The pairing link's host ladder needs two slow probes (Tailscale, the `.local`
  // lookup). Run them in the background now, only when the link will use the
  // ladder, so opening the modal never waits on them and already has the answer.
  if (pairingOriginUsesStableHost(deps.configManager)) void refreshStableHostInputs();
  manager.registerModalSurface(createPairingModalSurface({
    getConnectionInfo: (request) => buildPairingConnectionInfo(deps, request),
    controlPlaneReadModel: ui.readModels.controlPlane,
    copyToClipboard,
    probeTailscale: () => probePairingTailscale(tailscaleGatewayDeps),
    runTailscaleServe: () => runPairingTailscaleServe(tailscaleGatewayDeps),
  }));
  manager.registerModalRedirect('qr-code', 'pairing-modal');

  // Paired-device management (settings security domain): list/rename/revoke/
  // migrate-shared over the same per-device token store the pairing QR mints into.
  manager.registerModalSurface(createDevicesModalSurface({
    pairingTokens: ui.platform.pairingTokens,
    copyToClipboard,
  }));
  manager.registerModalRedirect('devices', 'devices-modal');

  manager.registerModalSurface(createPlanningModalSurface({
    service: deps.projectPlanningService,
    projectId: deps.projectPlanningProjectId,
    requestRender: deps.requestRender,
  }));
  manager.registerModalRedirect('project-planning', 'native-work-ledger-modal');

  // The retired 'sessions' view folds into the EXISTING session-picker modal
  // (no new config-modal surface); the redirect is a plain hand-off, moved here
  // from the deleted ecosystem bridge.
  manager.registerModalRedirect('sessions', 'sessionPicker');
}

/**
 * Build the companion-pairing connection info lazily (called from the pairing
 * surface's first render, not at registration time). A failure (a token store
 * that cannot be written, a config error, the device cap) is thrown as it is:
 * the pairing modal shows its message, so the cause is not guessed here.
 * Mirrors the retired Qr view factory's construction.
 */
export function buildPairingConnectionInfo(deps: ResolvedBuiltinViewDeps, request: PairingConnectionRequest = {}): PairingModalConnectionInfo {
  const ui = deps.uiServices;
  const configManager = deps.configManager;
  // Freeze a stable web origin once (never clobbering a user-set value).
  const webOrigin = ensurePublicBaseUrl(configManager);
  const url = webOrigin.alternateOrigin ? `${webOrigin.origin}  (or ${webOrigin.alternateOrigin})` : webOrigin.origin;
  const held = request.held;
  // Reopening shows the same offer while nobody has used it and it has not
  // expired: no new credential, no write. Otherwise the new offer replaces it.
  if (!request.fresh && held?.tokenId !== undefined && held.url === url && ui.platform.pairingTokens.isOpenOffer(held.tokenId)) return held;
  const offers = availablePairingOffers({
    relayEnabled: configManager.get('relay.enabled') === true,
    // The TUI composition always wires a step-up service ⇒ the passkey offer is
    // presentable; the web app declines it if the device has no authenticator.
    stepUpAvailable: true,
  });
  // Mint a per-device offer and encode the canonical `#pair=` deep link,
  // the same mint the pairing.handoff.create verb performs, no raw JSON blob.
  const handoff = mintPairingHandoff({
    pairingTokens: ui.platform.pairingTokens,
    name: defaultPairingTokenName(),
    offers,
    webOrigin: webOrigin.origin,
    replacesOffer: held?.tokenId,
  });
  return {
    // The routable address rides beside a name the device may not resolve.
    url,
    token: handoff.token.token,
    tokenName: handoff.token.name,
    deepLink: handoff.deepLink ?? handoff.fragment,
    offers: handoff.offers,
    posture: handoff.posture,
    tokenId: handoff.token.id,
  };
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


/** Production provider-console composition, shared with focused boundary tests. */
export function createBuiltinProviderHealthModalSurface(deps: ResolvedBuiltinViewDeps): ConfigModalSurface {
  const ui = deps.uiServices;
  const providerRuntime = createProviderRuntimeInspectionQuery(createRuntimeProviderApi({
    benchmarkStore: ui.providers.benchmarkStore,
    favoritesStore: ui.providers.favoritesStore,
    providerRegistry: ui.providers.providerRegistry,
  }));
  const m = ui.readModels;
  const domainModels = [m.localAuth, m.settings, m.remote, m.security, m.intelligence, m.continuity, m.worktrees, m.session] as const;
  return createProviderHealthModalSurface(providerRuntime, m.providers, () => ({
    configManager: deps.configManager,
    auth: m.localAuth.getSnapshot(),
    settings: m.settings.getSnapshot(),
    remote: m.remote.getSnapshot(),
    security: m.security.getSnapshot(),
    intelligence: m.intelligence.getSnapshot(),
    continuity: m.continuity.getSnapshot(),
    worktrees: m.worktrees.getSnapshot(),
    session: m.session.getSnapshot(),
  }), (listener) => {
    const unsubs = domainModels.map((model) => model.subscribe(listener));
    return () => { for (const unsub of unsubs) unsub(); };
  });
}
