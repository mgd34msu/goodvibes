import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import type { MintedPairingToken, PublicPairingToken } from '@goodvibes-jev/engine/platform/platform/pairing';
import { formatDeviceLine, shortTokenId } from '@goodvibes-jev/engine/platform/platform/pairing';

// ---------------------------------------------------------------------------
// Paired Devices, the settings security-domain device/token management surface.
// Lists every per-device pairing token (name · created · last-seen · id) and
// mirrors the pairing.tokens.* gateway verbs: revoke a device, migrate off the
// shared token, revoke the shared token (through the daemon, which replaces
// it so this machine's apps stay signed in). Rename needs a name, which the
// stable-layout modal cannot capture inline, so its status line names the
// /devices rename command with the row's id filled in. Every action answers in
// the modal's status line; nothing is printed under the modal. A migration's
// one-time token is always shown in this modal (masked until revealed, dropped
// on close); copying it to the terminal clipboard is an extra, since a terminal
// that ignores OSC 52 drops it without telling anyone.
// ---------------------------------------------------------------------------

/** The token-store capability this surface needs, satisfied by PairingTokenManager. */
export interface DevicesModalPairingTokens {
  list(): PublicPairingToken[];
  rename(id: string, name: string): boolean;
  revoke(id: string): boolean;
  mintForMigration(input: { readonly name: string }): MintedPairingToken;
  isLegacyRevoked(): boolean;
}

export interface DevicesModalDeps {
  readonly pairingTokens: DevicesModalPairingTokens;
  /** Asks the daemon to revoke and replace the shared token; absent where no daemon is reachable from here. */
  readonly revokeShared?: () => Promise<{ readonly ok: boolean; readonly message: string }>;
  /** Injectable clock so last-seen formatting is deterministic in tests. */
  readonly now?: () => number;
  /** Writes the terminal clipboard escape; true when it was written (the terminal never confirms it). */
  readonly copyToClipboard?: (text: string) => boolean | void;
}

const DEVICE_ROW_PREFIX = 'device:';

/** A token minted by `/devices migrate-shared`, waiting for the view to open and show it. */
let pendingReveal: { readonly name: string; readonly token: string } | null = null;

/**
 * Hand a freshly minted token to the Paired Devices view, which shows it masked
 * until revealed and forgets it when it closes. The token is never printed.
 */
export function holdMintedTokenForReveal(minted: Pick<MintedPairingToken, 'name' | 'token'>): void {
  pendingReveal = { name: minted.name, token: minted.token };
}
// Fixed-width placeholder, not derived from the token's length.
const SECRET_MASK = '••••••••••••';

function deviceIdOf(row: ConfigModalRow | null): string | null {
  return row && row.id.startsWith(DEVICE_ROW_PREFIX) ? row.id.slice(DEVICE_ROW_PREFIX.length) : null;
}

class DevicesModalSurface implements ConfigModalSurface {
  readonly name = 'devices-modal';
  readonly title = 'Paired Devices';
  private requestRender: () => void = () => {};
  /** The one-time token minted by 'm'. Shown masked in a row, never printed to the transcript. */
  private minted: { readonly name: string; readonly token: string } | null = null;
  private mintedRevealed = false;

  constructor(private readonly deps: DevicesModalDeps) {}

  readonly actions = [
    { key: 'r', id: 'rename', label: 'rename', enabledFor: (row: ConfigModalRow | null) => deviceIdOf(row) !== null },
    { key: 'x', id: 'revoke', label: 'revoke', confirm: true, enabledFor: (row: ConfigModalRow | null) => deviceIdOf(row) !== null },
    { key: 'm', id: 'migrateShared', label: 'migrate off shared token', confirm: true, enabledFor: () => !this.deps.pairingTokens.isLegacyRevoked() },
    { key: 'v', id: 'toggleReveal', label: 'reveal minted token', enabledFor: () => this.minted !== null },
    { key: 'c', id: 'copyMinted', label: 'copy minted token', enabledFor: () => this.minted !== null && Boolean(this.deps.copyToClipboard) },
    { key: 's', id: 'revokeShared', label: 'revoke shared token', confirm: true, enabledFor: () => !this.deps.pairingTokens.isLegacyRevoked() },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    if (pendingReveal) {
      this.minted = pendingReveal;
      this.mintedRevealed = false;
      pendingReveal = null;
    }
  }

  /** A one-time token held for display is dropped when the modal closes. */
  onClose(): void { this.minted = null; this.mintedRevealed = false; }

  buildView(): ConfigModalView {
    const now = this.deps.now?.() ?? Date.now();
    const tokens = this.deps.pairingTokens.list();
    const rows: ConfigModalRow[] = [];
    rows.push(infoRow('intro', 'Devices paired to this daemon. Each has its own token; revoke one without affecting the others.', { fg: MODAL_TONES.dim }));

    if (tokens.length === 0) {
      rows.push(infoRow('empty', 'No devices paired yet: run /pair (or open the pairing QR) to add one.'));
    } else {
      for (const token of tokens) {
        rows.push({ id: `${DEVICE_ROW_PREFIX}${token.id}`, label: formatDeviceLine(token, now) });
      }
    }

    if (this.minted) {
      rows.push(infoRow('minted', `One-time token for "${this.minted.name}": ${this.mintedRevealed ? this.minted.token : SECRET_MASK}  (v ${this.mintedRevealed ? 'hide' : 'reveal'})`, { fg: MODAL_TONES.reasoning }));
    }

    const legacyRevoked = this.deps.pairingTokens.isLegacyRevoked();
    rows.push(infoRow(
      'legacy',
      legacyRevoked
        ? 'Shared token: revoked and replaced; only the apps on this machine hold it.'
        : 'Shared token: active. This machine\'s own apps (this terminal, the Agent, the daemon CLI) sign in with it, as do devices paired before per-device tokens. Move a device to its own token with Ctrl+G then m. Revoking it (Ctrl+S) signs out every other device still using it; the daemon writes a new one for this machine, so its apps stay signed in.',
      legacyRevoked ? { fg: MODAL_TONES.dim } : { fg: MODAL_TONES.reasoning },
    ));

    return {
      title: 'Paired Devices',
      tabs: [{ id: 'devices', label: 'Devices', rows, hints: ['r rename', 'x revoke', 'm migrate off shared', 's revoke shared', ...(this.minted ? ['v reveal minted token', ...(this.deps.copyToClipboard ? ['c copy it'] : [])] : [])] }],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    const tokens = this.deps.pairingTokens;

    if (id === 'rename') {
      const deviceId = deviceIdOf(ctx.row);
      if (!deviceId) { ctx.setStatus('Select a device row first.'); return; }
      // The stable-layout modal cannot capture a name inline, route to the
      // command with the id pre-filled so the user only types the new name.
      ctx.setStatus(`To rename this device, close this view (Esc) and run: /devices rename ${shortTokenId(deviceId)} <new name>`);
      return;
    }

    if (id === 'revoke') {
      const deviceId = deviceIdOf(ctx.row);
      if (!deviceId) { ctx.setStatus('Select a device row first.'); return; }
      const record = tokens.list().find((t) => t.id === deviceId);
      const revoked = tokens.revoke(deviceId);
      ctx.setStatus(revoked ? `Revoked "${record?.name ?? shortTokenId(deviceId)}": its token stops working now.` : 'That device was already absent.');
      this.requestRender();
      return;
    }

    if (id === 'migrateShared') {
      const minted = tokens.mintForMigration({ name: 'migrated device' });
      this.minted = { name: minted.name, token: minted.token };
      this.mintedRevealed = false;
      ctx.setStatus(`Minted "${minted.name}" (id ${shortTokenId(minted.id)}). Press Ctrl+V to reveal its one-time token${this.deps.copyToClipboard ? ' or Ctrl+G then c to copy it' : ''}, then pair the device with it.`);
      this.requestRender();
      return;
    }

    if (id === 'copyMinted') {
      if (!this.minted || !this.deps.copyToClipboard) return;
      const written = this.deps.copyToClipboard(this.minted.token);
      ctx.setStatus(written === false
        ? 'Could not write to the terminal clipboard; press Ctrl+V to reveal the token instead.'
        : 'Sent the token to the terminal clipboard, if your terminal supports it (OSC 52); press Ctrl+V to reveal it if the paste is empty.');
      return;
    }

    if (id === 'toggleReveal') {
      if (!this.minted) return;
      this.mintedRevealed = !this.mintedRevealed;
      this.requestRender();
      return;
    }

    if (id === 'revokeShared') {
      if (tokens.isLegacyRevoked()) { ctx.setStatus('The shared token is already revoked; only this machine holds its replacement.'); return; }
      const revokeShared = this.deps.revokeShared;
      if (!revokeShared) { ctx.setStatus('The shared token is revoked by the daemon, and no daemon is reachable from here.'); return; }
      ctx.setStatus('Asking the daemon to revoke and replace the shared token...');
      void revokeShared().then(
        (outcome) => { ctx.setStatus(outcome.message); this.requestRender(); },
        (error: unknown) => { ctx.setStatus(`The shared token was not revoked: ${error instanceof Error ? error.message : String(error)}`); this.requestRender(); },
      );
      return;
    }
  }
}

export function createDevicesModalSurface(deps: DevicesModalDeps): ConfigModalSurface {
  return new DevicesModalSurface(deps);
}
