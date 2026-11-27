/**
 * device-posture-composition.ts, the paired-phone feature inside THIS daemon.
 *
 * A phone pairs with whichever daemon the person runs. Until this module
 * existed this daemon had no device posture at all: `device.nodes.maxPaired`
 * was enforced at the pairing path (platform-side) and `device.capabilities.mode`
 * was an onboarding toggle, while the other eleven `device.*` keys were
 * recorded, read back, and governed nothing, the capability service they
 * describe was never built here, so there was nothing for them to govern.
 *
 * The feature itself is platform-owned (`platform/devices`): the settings→policy
 * mapping, the grants ledger, the capture store, the housekeeping sweeps, the
 * owner question, and the `phone` tool. This module supplies the seams that are
 * actually ours and nothing else:
 *
 *   - the peer transport, the same DistributedRuntimeManager the remote surface
 *     pairs devices onto, so a phone paired here is a node here,
 *   - the approval path, the shared approval broker, so the owner's question
 *     (asked only when the owner's own per-device "ask every request" rule asks; the act itself was decided once before it
 *     reached here) appears wherever the owner is looking (terminal, web app, companion),
 *   - the storage root, the live config manager and the daemon's lifetime.
 *
 * Constructing this starts nothing. The daemon host awaits
 * `devicePosture.startHousekeeping()` during its start: grants and captures
 * both outlive a restart, so a grant whose phone is gone, or a capture torn by
 * a crash, is reaped BEFORE the first request of this run is served, and the
 * periodic sweep armed after it keeps a long-running daemon from going days
 * without one. The rule is the engine's (device-posture-runtime.ts): a grant
 * sweep that fails refuses the start, since a departed phone's grant must not
 * be honoured on the first request; a capture sweep that fails is logged and
 * the start goes on; the periodic sweep is armed either way.
 */
import { nativeDeviceRecoveryObserver } from './startup-observation.js';
import { createDevicePostureRuntime } from '@goodvibes/engine/platform/platform/devices';
import type {
  DeviceApprovalBridge,
  DevicePeerTransport,
  DevicePostureRuntime,
  DevicePostureRuntimeOptions,
} from '@goodvibes/engine/platform/platform/devices';
import { registerDevicesGatewayMethods } from '@goodvibes/engine/platform/platform/control-plane';
import type { ApprovalBroker, GatewayMethodCatalog } from '@goodvibes/engine/platform/platform/control-plane';
import { isEffectiveDangerMode, type ConfigManager } from '@goodvibes/engine/platform/platform/config';

/** Who this surface records in the device audit trail. */
export const DAEMON_DEVICE_ACTOR = 'daemon:phone-tool';

export interface DevicePostureCompositionOptions {
  readonly configManager: ConfigManager;
  /** The daemon's lifetime; aborting it withdraws requests no phone has picked up. */
  readonly signal?: AbortSignal | undefined;
  /** The runtime devices pair onto; its listPeers/invokePeer are the transport. */
  readonly distributedRuntime: DevicePeerTransport;
  /** The shared approval broker the owner's question rides; its settled record names who answered. */
  readonly approvals: Pick<ApprovalBroker, 'raiseApproval' | 'getApproval'>;
  /** The authority record the durable grants live on, shared with every machine of the group. */
  readonly authority: DevicePostureRuntimeOptions['authority'] | undefined;
  /** Surface-scoped directory the grants ledger, captures and disclosure live in. */
  readonly stateDirectory: string;
  /**
   * Binding the catalog turns the whole devices.* family from
   * cataloged-but-unhandled into real handlers: nodes.list, grants.*,
   * housekeeping.run, and, since a surface with no device runtime of its own
   * could read the grants and never open a camera, capability.request and
   * artifacts.list/read. That is what makes the paired phone usable from the web
   * app and the companion rather than only through this process's own tool.
   *
   * The runtime is handed over whole because the verbs and the tool must reach
   * the SAME service: a second path to a phone would be a second place the
   * owner's question and the durable grants could be decided differently.
   */
  readonly gatewayMethods?: GatewayMethodCatalog | undefined;
  readonly getSessionId?: (() => string | undefined) | undefined;
}

export interface DevicePostureServices {
  readonly devicePosture: DevicePostureRuntime;
}

/**
 * The runtime lists 200 peers unless asked for more, and the grant ownership
 * check reads that list: a paired device past the 200th would look like a
 * departed node and have its grants reaped. Ask for every peer.
 */
const ALL_PEERS = Number.MAX_SAFE_INTEGER;

function listingEveryPeer(source: DevicePeerTransport): DevicePeerTransport {
  // Resolved on every call: the transport's methods are the live ones.
  return {
    listPeers: (kind) => (source.listPeers as (kind?: string, limit?: number) => ReturnType<DevicePeerTransport['listPeers']>).call(source, kind, ALL_PEERS),
    invokePeer: (input) => source.invokePeer(input),
    ...(source.cancelWork ? { cancelWork: (workId: string, input?: Parameters<NonNullable<DevicePeerTransport['cancelWork']>>[1]) => source.cancelWork!(workId, input) } : {}),
  };
}

/**
 * The broker as the device bridge: raise the ask, await its decision, and read
 * who answered off the settled record, so a durable grant and its audit entry
 * name that principal rather than a generic `operator`.
 */
function deviceApprovalsFrom(broker: DevicePostureCompositionOptions['approvals']): DeviceApprovalBridge {
  return {
    async requestApproval(input) {
      const raised = await broker.raiseApproval(input);
      const decision = await raised.decision;
      const decidedBy = broker.getApproval(raised.approval.id)?.resolvedBy;
      return decidedBy !== undefined ? { ...decision, decidedBy } : decision;
    },
  };
}

/** Build the device posture runtime and bind the device verbs to it. */
export function createDevicePostureServices(options: DevicePostureCompositionOptions): DevicePostureServices {
  if (!options.authority) throw new Error('The paired-device feature needs the authority record its grants live on, and this runtime graph has none.');
  const devicePosture = createDevicePostureRuntime({
    authority: options.authority,
    transport: listingEveryPeer(options.distributedRuntime),
    approvals: deviceApprovalsFrom(options.approvals),
    config: options.configManager,
    nativeDataWriter: options.configManager.getNativeDataWriter?.(),
    ...(nativeDeviceRecoveryObserver ? { observeRecovery: nativeDeviceRecoveryObserver } : {}),
    stateDirectory: options.stateDirectory,
    actor: DAEMON_DEVICE_ACTOR,
    // As released: a request no grant covers runs in YOLO and asks the owner ("Use a paired phone?") in every other mode.
    // Anyone else's request for a capture, the screen, the location or the clipboard is refused flat at the dispatch
    // (control-plane/method-risk.ts `owner-act`) before it reaches here.
    noGrantAuthority: () => (isEffectiveDangerMode(options.configManager) ? 'allow' : 'ask-owner'),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.getSessionId ? { getSessionId: options.getSessionId } : {}),
  });
  if (options.gatewayMethods) registerDevicesGatewayMethods(options.gatewayMethods, devicePosture);
  return { devicePosture };
}
