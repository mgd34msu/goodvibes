import type { ModalSurfaceRegistry } from './modal-surface-registry.ts';
import type { ResolvedBuiltinViewDeps } from './view-deps.ts';
import type { ConfigModalSurface, ConfigModalView } from '../input/config-modal-types.ts';
import { copyToClipboard } from '../utils/clipboard.ts';
import { pairingNoWebUiLines, pairingOriginUsesStableHost, pairingReachFromSettings, pairingThisMachineLines, refreshStableHostInputs, resolvePairingWebOrigin } from '@goodvibes/engine/platform/platform/pairing';
import { availablePairingOffers, mintPairingHandoff, defaultPairingTokenName, PAIRING_HANDOFF_OFFER_KINDS, type OriginPosture, type PairingHandoffOfferKind } from '@goodvibes/engine/platform/platform/pairing';
import { probePairingTailscale, runPairingTailscaleServe, stopPairingTailscaleServe } from '../core/pairing-tailscale-gateway.ts';
import { createKeybindingsModalSurface } from './modals/keybindings-modal.ts';
import { createPairingModalSurface, type PairingConnectionRequest, type PairingModalConnectionInfo, type PairingModalUnreachable } from './modals/pairing-modal.ts';
import { describeOperatorRpcError, invokePressed, resolveOperatorRpc } from '../runtime/client/operator-endpoint.ts';

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
    stopTailscaleServe: () => stopPairingTailscaleServe(tailscaleGatewayDeps),
    serveToNetwork: (name) => servePairingToNetwork(deps, name),
  }));
  manager.registerModalRedirect('qr-code', 'pairing-modal');

  // Paired devices are the Devices and network place (terminal-shell places/devices-place.ts).


  // The retired 'sessions' view folds into the EXISTING session-picker modal
  // (no new config-modal surface); the redirect is a plain hand-off, moved here
  // from the deleted ecosystem bridge.
  manager.registerModalRedirect('sessions', 'sessionPicker');
}

/** The step that makes a new pairing code: the control that opened this screen. */
const PAIR_AGAIN = 'Press Pair something (A phone or another device) in Devices and network again';

/**
 * Build the companion-pairing connection info lazily (called from the pairing
 * surface's first render, not at registration time). A failure (a token store
 * that cannot be written, a config error, the device cap) is thrown as it is:
 * the pairing modal shows its message, so the cause is not guessed here.
 * Mirrors the retired Qr view factory's construction.
 */
export function buildPairingConnectionInfo(deps: ResolvedBuiltinViewDeps, request: PairingConnectionRequest = {}): PairingModalConnectionInfo | PairingModalUnreachable {
  const ui = deps.uiServices;
  const configManager = deps.configManager;
  // Derived live from the settings (a user-set web.publicBaseUrl wins).
  const webOrigin = resolvePairingWebOrigin(configManager);
  // No code is minted for a phone that a phone could not open: the same
  // decision and the same steps `goodvibes pair` gives, from the settings, with
  // no probe. When only this machine can open it, the code is for a browser here.
  if (webOrigin === null) return { kind: 'unreachable', lines: pairingNoWebUiLines(PAIR_AGAIN) };
  const reach = pairingReachFromSettings(configManager, webOrigin.origin);
  const thisMachineOnly = reach.otherDevices ? undefined : pairingThisMachineLines(webOrigin.origin, reach, PAIR_AGAIN);
  const url = webOrigin.alternateOrigin ? `${webOrigin.origin}  (or ${webOrigin.alternateOrigin})` : webOrigin.origin;
  const held = request.held;
  // Reopening shows the same offer while nobody has used it and it has not
  // expired: no new credential, no write. Otherwise the new offer replaces it.
  if (!request.fresh && held?.tokenId !== undefined && held.url === url && (request.name === undefined || held.tokenName === request.name)
    && ui.platform.pairingTokens.isOpenOffer(held.tokenId)) {
    return { ...held, thisMachineOnly };
  }
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
    name: request.name ?? defaultPairingTokenName(),
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
    thisMachineOnly,
  };
}

/** pairing.handoff.create's answer, the fields the pairing screen shows. */
interface PairingHandoffAnswer {
  readonly token: { readonly id: string; readonly name: string; readonly token: string };
  readonly offers: readonly { readonly kind: PairingHandoffOfferKind }[];
  readonly fragment: string;
  readonly deepLink?: string | undefined;
  readonly posture?: OriginPosture | undefined;
}

/**
 * The owner's yes to SERVE_TO_NETWORK_QUESTION: the daemon serves its web UI to
 * the network, waits for its own listener to be bound again, and mints the code
 * for the address phones can open, in one request (pairing.handoff.create
 * `serveToNetwork`). It throws with the daemon's reason when it cannot.
 */
async function servePairingToNetwork(deps: ResolvedBuiltinViewDeps, name?: string): Promise<PairingModalConnectionInfo> {
  const rpc = resolveOperatorRpc({ configManager: deps.configManager, homeDirectory: deps.uiServices.environment.shellPaths.homeDirectory });
  if (!rpc.available) throw new Error(rpc.reason);
  let answer: PairingHandoffAnswer;
  try {
    // The owner's own yes in the modal: his press.
    answer = await invokePressed<PairingHandoffAnswer>(rpc.platformClient, 'pairing.handoff.create', {
      name: name ?? defaultPairingTokenName(),
      offers: [...PAIRING_HANDOFF_OFFER_KINDS],
      serveToNetwork: true,
    });
  } catch (error) { throw new Error(describeOperatorRpcError(error)); }
  const deepLink = answer.deepLink ?? answer.fragment;
  return {
    url: answer.posture?.origin ?? deepLink,
    token: answer.token.token,
    tokenName: answer.token.name,
    deepLink,
    offers: answer.offers.map((offer) => offer.kind),
    posture: answer.posture,
    tokenId: answer.token.id,
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

