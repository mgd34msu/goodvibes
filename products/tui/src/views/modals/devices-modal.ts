import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import { actionKeyText } from '../../input/config-modal-keys.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import type { MintedPairingToken, PublicPairingToken } from '@goodvibes/engine/platform/platform/pairing';
import { formatDeviceLine, shortTokenId } from '@goodvibes/engine/platform/platform/pairing';

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
  rename(id: string, name: string): Promise<boolean>;
  /** Revokes here and on the authority record, so the device is refused on every machine of the group. */
  revokeEverywhere(id: string): Promise<{ readonly revoked: boolean; readonly alsoRevoked: readonly string[] }>;
  mintForMigration(input: { readonly name: string; readonly origin?: 'owner-pairing' | 'automation' | undefined }): MintedPairingToken;
  isLegacyRevoked(): boolean;
}

export interface DevicesModalDeps {
  readonly pairingTokens: DevicesModalPairingTokens;
  /** Asks the daemon to revoke and replace the shared token; absent where no daemon is reachable from here. */
  readonly revokeShared?: () => Promise<{ readonly ok: boolean; readonly message: string }>;
  /** Injectable clock so last-seen formatting is deterministic in tests. */
  readonly now?: () => number;
  /** Copies the text: `copied` when a clipboard program confirmed it, `sent` when it went to the terminal as OSC 52. */
  readonly copyToClipboard?: (text: string) => 'copied' | 'sent' | 'failed';
  /** The daemon's LIST_CHANGED `paired-devices` notices while the screen is open; returns the unsubscribe. */
  readonly watchPairedDevices?: (onChange: () => void) => () => void;
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
    // Once revoked, the same action replaces the replacement, so a copy of it taken off this machine stops signing in.
    { key: 's', id: 'revokeShared', label: 'revoke or replace shared token', confirm: true, enabledFor: () => true },
  ];

  /** Stops following the daemon's paired-devices notices; set while the screen is open. */
  private unwatch: () => void = () => {};

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    // A device paired, renamed or revoked through the daemon (a phone, the web app) redraws the list with no key:
    // the render reads the device list again, which takes in the daemon's write.
    this.unwatch();
    this.unwatch = this.deps.watchPairedDevices?.(() => this.requestRender()) ?? (() => {});
    if (pendingReveal) {
      this.minted = pendingReveal;
      this.mintedRevealed = false;
      pendingReveal = null;
    }
  }

  /** A one-time token held for display is dropped when the modal closes. */
  onClose(): void { this.unwatch(); this.unwatch = () => {}; this.minted = null; this.mintedRevealed = false; }

  buildView(): ConfigModalView {
    const now = this.deps.now?.() ?? Date.now();
    const tokens = this.deps.pairingTokens.list();
    const rows: ConfigModalRow[] = [];
    rows.push(infoRow('intro', 'Devices paired to this daemon. Each has its own token; revoke one without affecting the others.', { fg: MODAL_TONES.dim }));

    if (tokens.length === 0) {
      rows.push(infoRow('empty', 'No devices paired yet: run /devices pair to add one.'));
    } else {
      for (const token of tokens) {
        rows.push({ id: `${DEVICE_ROW_PREFIX}${token.id}`, label: formatDeviceLine(token, now) });
      }
    }

    if (this.minted) {
      rows.push(infoRow('minted', `One-time token for "${this.minted.name}": ${this.mintedRevealed ? this.minted.token : SECRET_MASK}  (${actionKeyText('v')} ${this.mintedRevealed ? 'hide' : 'reveal'})`, { fg: MODAL_TONES.reasoning }));
    }

    const legacyRevoked = this.deps.pairingTokens.isLegacyRevoked();
    rows.push(infoRow(
      'legacy',
      legacyRevoked
        ? 'Shared token: revoked and replaced; only the apps on this machine hold it. Ctrl+S replaces it again if a copy may have left this machine; the apps here read the new one and stay signed in.'
        : `Shared token: active. This machine's own apps (this terminal, the Agent, the daemon CLI) sign in with it, as do devices paired before per-device tokens. Move a device to its own token with ${actionKeyText('m')}. Revoking it (Ctrl+S) signs out every other device still using it; the daemon writes a new one for this machine, so its apps stay signed in.`,
      legacyRevoked ? { fg: MODAL_TONES.dim } : { fg: MODAL_TONES.reasoning },
    ));

    return {
      title: 'Paired Devices',
      // The footer's keys are the actions' own hints (each shown only when it applies); a tab hint list here drew them twice.
      tabs: [{ id: 'devices', label: 'Devices', rows }],
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
      const listed = tokens.list();
      const nameOf = (id: string): string => listed.find((t) => t.id === id)?.name ?? shortTokenId(id);
      const name = nameOf(deviceId);
      ctx.setStatus(`Revoking "${name}"...`);
      void tokens.revokeEverywhere(deviceId).then(
        (outcome) => {
          const also = outcome.alsoRevoked.length > 0 ? ` Also revoked with it: ${outcome.alsoRevoked.map((id) => `"${nameOf(id)}"`).join(', ')}.` : '';
          ctx.setStatus(outcome.revoked ? `Revoked "${name}": its token stops working now.${also}` : 'That device was already absent.');
          this.requestRender();
        },
        (error: unknown) => { ctx.setStatus(`"${name}" was not revoked: ${error instanceof Error ? error.message : String(error)}`); this.requestRender(); },
      );
      return;
    }

    if (id === 'migrateShared') {
      // Minted at the owner's own terminal for one of his devices: an owner device.
      const minted = tokens.mintForMigration({ name: 'migrated device', origin: 'owner-pairing' });
      this.minted = { name: minted.name, token: minted.token };
      this.mintedRevealed = false;
      ctx.setStatus(`Minted "${minted.name}" (id ${shortTokenId(minted.id)}). Press Ctrl+V to reveal its one-time token${this.deps.copyToClipboard ? ` or ${actionKeyText('c')} to copy it` : ''}, then pair the device with it.`);
      this.requestRender();
      return;
    }

    if (id === 'copyMinted') {
      if (!this.minted || !this.deps.copyToClipboard) return;
      const written = this.deps.copyToClipboard(this.minted.token);
      ctx.setStatus(written === 'failed'
        ? `Could not copy the token; press ${actionKeyText('v')} to reveal it instead.`
        : written === 'copied'
          ? 'Copied the token.'
          : `Sent the token to your terminal's clipboard, if your terminal supports it (OSC 52); press ${actionKeyText('v')} to reveal it if the paste is empty.`);
      return;
    }

    if (id === 'toggleReveal') {
      if (!this.minted) return;
      this.mintedRevealed = !this.mintedRevealed;
      this.requestRender();
      return;
    }

    if (id === 'revokeShared') {
      const replacing = tokens.isLegacyRevoked();
      const revokeShared = this.deps.revokeShared;
      if (!revokeShared) { ctx.setStatus('The shared token is revoked by the daemon, and no daemon is reachable from here.'); return; }
      ctx.setStatus(replacing
        ? 'Asking the daemon to replace the shared token this machine holds...'
        : 'Asking the daemon to revoke and replace the shared token...');
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
