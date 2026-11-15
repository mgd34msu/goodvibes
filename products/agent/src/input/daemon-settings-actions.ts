import type { CommandContext } from './command-registry.ts';
import type { SelectionItem } from './selection-modal.ts';
import { agentDaemonConfigClient } from '../config/daemon-config-routing.ts';
import { routeSettingWriteToConnectedHost } from './settings-modal-daemon-writes.ts';

/** Selecting this item clears daemon.timezone back to '' (UTC). */
const UTC_UNSET_ID = '__daemon_timezone_utc_unset__';

const TIMEZONE_KEY = 'daemon.timezone';

/**
 * A picker over every IANA zone name Intl actually recognizes on this host,
 * plus an explicit unset option, never a free-text field, so a typo can't
 * silently produce an invalid zone the daemon then fails to parse.
 *
 * `daemon.timezone` is the daemon's setting: with a connected host the
 * current value is read from it (one request) and the choice is written to it
 * through the same routed writer the settings screen uses, so a daemon on
 * another machine changes zone and a refusal is reported, not a local copy.
 */
export function openDaemonTimezonePicker(ctx: CommandContext): boolean {
  if (!ctx.openSelection) return false;
  const client = agentDaemonConfigClient();
  if (client?.ownsKey(TIMEZONE_KEY)) {
    void client.get(TIMEZONE_KEY).then(
      (value) => showTimezonePicker(ctx, value === undefined ? undefined : String(value ?? '').trim()),
      () => showTimezonePicker(ctx, undefined),
    );
    return true;
  }
  showTimezonePicker(ctx, String(ctx.platform.configManager.get(TIMEZONE_KEY) ?? '').trim());
  return true;
}

/** `current` is undefined when the connected host could not say which zone it holds. */
function showTimezonePicker(ctx: CommandContext, current: string | undefined): void {
  if (!ctx.openSelection) return;
  const zones = Intl.supportedValuesOf('timeZone');

  const items: SelectionItem[] = [
    {
      id: UTC_UNSET_ID,
      label: 'UTC (unset)',
      detail: current === '' ? '(current)' : 'clears daemon.timezone',
      category: 'timezone',
      primaryAction: 'select',
      actions: '[Enter] set timezone',
    },
    ...zones.map((zone) => ({
      id: zone,
      label: zone,
      detail: zone === current ? `${zone}  (current)` : zone,
      category: 'IANA timezones',
      primaryAction: 'select' as const,
      actions: '[Enter] set timezone',
    })),
  ];

  const title = current === undefined ? 'Choose Daemon Timezone (host value unavailable)' : 'Choose Daemon Timezone';
  ctx.openSelection(title, items, { preSelectId: current || UTC_UNSET_ID, allowSearch: true }, (result) => {
    if (!result) return;
    const nextZone = result.item.id === UTC_UNSET_ID ? '' : result.item.id;
    const done = nextZone ? `Daemon timezone set to ${nextZone}` : 'Daemon timezone cleared (UTC)';
    const routed = routeSettingWriteToConnectedHost(TIMEZONE_KEY, nextZone, (update) => {
      if (!update.settled) return;
      ctx.print(update.ok ? `${done} on the connected host.` : `${update.message}\nThe daemon keeps its previous timezone. Check the connection with /status, then choose the zone again.`);
      ctx.renderRequest();
    });
    if (routed) return;
    ctx.platform.configManager.setDynamic(TIMEZONE_KEY, nextZone);
    ctx.print(`${done}.`);
    ctx.renderRequest();
  });
}
