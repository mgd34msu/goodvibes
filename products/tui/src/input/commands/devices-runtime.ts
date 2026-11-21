import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { shortTokenId, type MintedPairingToken, type PublicPairingToken } from '@goodvibes/engine/platform/platform/pairing';
import { readConnectedDaemonOrigin } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { describeOperatorRpcError } from '../../runtime/client/operator-endpoint.ts';
import { holdMintedTokenForReveal } from '../../views/modals/devices-modal.ts';
import { revokeSharedTokenOnDaemon } from '../../runtime/client/shared-token-revocation.ts';
import { getOperatorRpc } from './operator-rpc.ts';
import { registerDevicesCommand, type DeviceTokens, type PairRequest, type PairRequestsHost } from '@goodvibes/engine/terminal-shell/devices-command';
import { CHANNELS_LIST } from '@goodvibes/engine/terminal-shell/channels-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import { openModalCommand } from './runtime-services.ts';
import { runChannelPairing } from './channel-pairing.ts';
import { pairRelay, relayCodes, relayStatus, revokeRelayCode } from './relay-runtime.ts';
import { resolveNativeHostCredential } from '../../runtime/client/native-host-credential.ts';
import { formatTuiHostPairing, unpairTuiHost } from '../../runtime/tui-host-pairing.ts';

/**
 * The device tokens of the daemon this terminal talks to. Its pairing store is
 * the daemon's: with a daemon reachable every verb goes to it through the
 * operator API (`pairing.tokens.*`), so with `daemon.connectedHost.url` set the
 * daemon there is the one changed. Only when the selected daemon is this
 * machine's and does not answer does the command use this machine's pairing
 * file directly (the daemon reads it when it starts).
 */
interface DeviceTokenStore {
  /** Where the devices are, for the lines printed. */
  readonly where: string;
  list(): Promise<readonly PublicPairingToken[]>;
  legacyRevoked(): Promise<boolean>;
  rename(id: string, name: string): Promise<boolean>;
  revoke(id: string): Promise<boolean>;
  mintForMigration(name: string): Promise<MintedPairingToken>;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { readonly status?: unknown }).status === 404);
}

function deviceTokenStore(ctx: CommandContext): DeviceTokenStore {
  const connected = readConnectedDaemonOrigin((key) => ctx.platform.configManager.get(key));
  const rpc = getOperatorRpc(ctx);
  if (rpc.available) {
    const invoke = <T,>(method: string, input: Record<string, unknown>): Promise<T> =>
      rpc.platformClient.operator.invoke(method as never, input as never) as Promise<T>;
    const listed = () => invoke<{ readonly tokens: readonly PublicPairingToken[]; readonly legacySharedRevoked: boolean }>('pairing.tokens.list', {});
    return {
      where: connected ? `the daemon at ${rpc.origin}` : 'this machine\'s daemon',
      list: async () => (await listed()).tokens,
      legacyRevoked: async () => (await listed()).legacySharedRevoked,
      rename: async (id, name) => {
        try { return (await invoke<{ readonly renamed: boolean }>('pairing.tokens.rename', { id, name })).renamed; }
        catch (error) { if (isNotFound(error)) return false; throw error; }
      },
      revoke: async (id) => {
        let answer: { readonly revoked?: boolean; readonly approvalId?: string };
        try { answer = await invoke<{ readonly revoked?: boolean; readonly approvalId?: string }>('pairing.tokens.delete', { id }); }
        catch (error) { if (isNotFound(error)) return false; throw error; }
        if (typeof answer.revoked === 'boolean') return answer.revoked;
        // A device another principal paired is the owner's to revoke: the daemon put it to him instead (OWNER_APPROVAL_PENDING).
        const approval = typeof answer.approvalId === 'string' ? ` as approval ${answer.approvalId}` : '';
        throw commandRefusal(`Revoking this device is the owner's own act, so the daemon put it to him${approval}; nothing is revoked until he approves it.`,
          'The owner approves it from his own app (/approvals); the device keeps working until then.', 'OWNER_APPROVAL_PENDING');
      },
      mintForMigration: async (name) => (await invoke<{ readonly token: MintedPairingToken }>('pairing.tokens.migrate', { name })).token,
    };
  }
  if (connected) {
    throw commandRefusal(`The daemon at ${connected.baseUrl} could not be asked about its devices: ${rpc.reason}. Nothing was changed on this machine instead.`,
      'Check the connection to that daemon (/settings daemon), then run the command again', 'NOT_DONE');
  }
  const local = ctx.platform.pairingTokens;
  if (!local) {
    throw commandRefusal('Device management is unavailable in this runtime (no pairing token service wired).', undefined, 'DEVICES_UNAVAILABLE');
  }
  return {
    where: 'this machine (its daemon is not answering; it reads these when it starts)',
    list: async () => local.list(),
    legacyRevoked: async () => local.isLegacyRevoked(),
    rename: async (id, name) => local.rename(id, name),
    revoke: async (id) => local.revoke(id),
    mintForMigration: async (name) => local.mintForMigration({ name }),
  };
}

/** A daemon call that failed for a reason other than a refusal says where and why. */
async function onDaemon<T>(store: DeviceTokenStore, what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && 'refusal' in error) throw error;
    throw commandRefusal(`${what} on ${store.where} did not finish: ${describeOperatorRpcError(error)}`, '/devices list shows the current devices', 'NOT_DONE');
  }
}

async function readTokens(ctx: CommandContext): Promise<DeviceTokens> {
  const store = deviceTokenStore(ctx);
  return await onDaemon(store, 'Reading the devices', async () => ({ where: store.where, tokens: await store.list(), sharedRevoked: await store.legacyRevoked() }));
}

async function migrateShared(ctx: CommandContext, name: string): Promise<string> {
  const store = deviceTokenStore(ctx);
  const minted = await onDaemon(store, 'Making a token', () => store.mintForMigration(name));
  if (!ctx.openModal) {
    // No view to reveal it in: this display-only line is the one place it is shown.
    return `Made a token of its own, "${minted.name}" (id ${shortTokenId(minted.id)}), shown once: ${minted.token}\nPair the device with it, then run /devices revoke-shared to retire the shared token.`;
  }
  // The credential is shown in the Paired Devices view, masked until revealed, and dropped when it closes.
  holdMintedTokenForReveal(minted);
  ctx.openModal('devices-modal');
  return `Made a token of its own, "${minted.name}" (id ${shortTokenId(minted.id)}). Its one-time token is in the Paired Devices view: press Ctrl+V to reveal it. Pair the device with it, then run /devices revoke-shared to retire the shared token.`;
}

async function revokeShared(ctx: CommandContext): Promise<string> {
  const store = deviceTokenStore(ctx);
  if (await onDaemon(store, 'Reading the shared token', () => store.legacyRevoked())) return 'The shared token is already revoked; only this machine holds its replacement.';
  const revocation = await revokeSharedTokenOnDaemon(getOperatorRpc(ctx));
  if (!revocation.ok) throw commandRefusal(revocation.message, 'Start the daemon and run /devices revoke-shared again', 'NOT_DONE');
  return revocation.message;
}

/**
 * The daemon's devices waiting to pair as nodes (`remote.pair.requests.*`). Kept
 * by the daemon only, so without one answering the command is refused; a
 * failure keeps the daemon's code on the refusal (REMOTE_PAIR_REPLACES_PEER).
 */
function pairRequestsOnDaemon(): PairRequestsHost<CommandContext> {
  const call = async <T,>(ctx: CommandContext, what: string, method: string, input: Record<string, unknown>): Promise<T> => {
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) {
      throw commandRefusal(`Devices waiting to pair are kept by the daemon, which could not be asked: ${rpc.reason}.`, 'Start the daemon (or check /settings daemon), then run the command again', 'DAEMON_UNAVAILABLE');
    }
    try {
      return await (rpc.platformClient.operator.invoke(method as never, input as never) as Promise<T>);
    } catch (error) {
      if (error instanceof Error && 'refusal' in error) throw error;
      const code = error && typeof error === 'object' ? (error as { readonly code?: unknown }).code : undefined;
      throw commandRefusal(`${what} did not finish: ${describeOperatorRpcError(error)}`, '/devices requests shows the devices waiting to pair', typeof code === 'string' ? code : 'NOT_DONE');
    }
  };
  return {
    list: async (ctx) => (await call<{ readonly requests: readonly PairRequest[] }>(ctx, 'Reading the devices waiting to pair', 'remote.pair.requests.list', {})).requests,
    approve: async (ctx, id, confirmReplace) => (await call<{ readonly request: PairRequest }>(ctx, `Approving request ${id}`, 'remote.pair.requests.approve', confirmReplace ? { requestId: id, confirmReplace: true } : { requestId: id })).request,
    reject: async (ctx, id) => (await call<{ readonly request: PairRequest }>(ctx, `Rejecting request ${id}`, 'remote.pair.requests.reject', { requestId: id })).request,
  };
}

/** How this terminal reaches its daemon: a device pairing, or this machine's operator token. Local inspection only. */
function hostStatus(ctx: CommandContext): string {
  try {
    const credential = resolveNativeHostCredential({ configManager: ctx.platform.configManager, homeDirectory: requireShellPaths(ctx).homeDirectory });
    const reading = !credential.available ? credential.reason
      : credential.expectedPrincipalId
        ? `This terminal holds a device pairing for ${credential.baseUrl}. Live scopes and native authority are checked by each operation.`
        : `No device pairing is saved for ${credential.baseUrl}; it is the daemon on this machine, so the operator token this terminal already holds is used and no pairing is needed. Live scopes and native authority are checked by each operation.`;
    return `${reading}\nTo pair this terminal with a daemon on another machine: /devices pair host --bootstrap-shared, then add --apply to review and confirm.`;
  } catch {
    throw commandRefusal('This terminal\'s host credentials are unavailable here.', 'Use goodvibes host pair in an owner terminal');
  }
}

export function registerDevicesRuntimeCommands(registry: CommandRegistry): void {
  registerDevicesCommand<CommandContext>(registry, {
    tokens: readTokens,
    async rename(ctx, id, name) { const store = deviceTokenStore(ctx); return await onDaemon(store, 'Renaming the device', () => store.rename(id, name)); },
    async revoke(ctx, id) { const store = deviceTokenStore(ctx); return await onDaemon(store, 'Revoking the device', () => store.revoke(id)); },
    devices: (ctx) => ctx.platform.devices,
    async pairDevice(ctx, name) {
      // The pairing view shows a QR of an offer; the device takes its own token when it uses it, and is named there or with /devices rename.
      openModalCommand(ctx, 'pairing-modal');
      return name ? `Opened the pairing QR. Once the device has paired, /devices rename names it "${name}".` : 'Opened the pairing QR. Press r in it for a new offer; the one it replaces stops working unless a device already paired with it.';
    },
    async pairHost(ctx, request) {
      // Only the owner's own keyboard may begin the shell's cancellable pairing lifetime.
      if (isDirectOwnerCommandContext(ctx, 'devices') && ctx.beginHostPairing) {
        await ctx.beginHostPairing({ apply: request.apply, bootstrapShared: request.bootstrapShared, name: request.name || 'GoodVibes TUI' });
        return undefined;
      }
      if (request.apply) throw commandRefusal('Pairing with --apply needs the owner to type /devices pair host --bootstrap-shared --apply in the live owner terminal. Model, harness and nested commands cannot grant persistent administrative access.');
      return hostStatus(ctx);
    },
    hostStatus: async (ctx) => hostStatus(ctx),
    async unpairHost(ctx) {
      // Forgetting the credential cuts this terminal off from its host until the owner pairs again, so only the owner's own keyboard may do it.
      if (!isDirectOwnerCommandContext(ctx, 'devices')) throw commandRefusal('Forgetting this terminal\'s host credential counts only when the owner types /devices unpair-host in the terminal. Nothing was forgotten.');
      try {
        return formatTuiHostPairing(await unpairTuiHost({ configManager: ctx.platform.configManager, homeDirectory: requireShellPaths(ctx).homeDirectory }));
      } catch {
        throw commandRefusal('This terminal\'s host credentials are unavailable here.', 'Use goodvibes host unpair in an owner terminal');
      }
    },
    pairRelay: (ctx, name) => pairRelay(ctx, name || undefined),
    relayStatus,
    relayCodes,
    revokeRelayCode,
    async pairChannel(ctx, channel) { await runChannelPairing(channel, ctx); },
    migrateShared,
    revokeShared,
    pairRequests: pairRequestsOnDaemon(),
  }, CHANNELS_LIST);
}
