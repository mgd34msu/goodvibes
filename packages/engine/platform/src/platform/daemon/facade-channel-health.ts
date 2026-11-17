/**
 * The daemon's channel-health watcher, and the announcer that makes it matter.
 *
 * Making a channel's reported state honest fixes the answer to a question that
 * nobody asks. The lived failure was not that a status endpoint said the wrong
 * thing, it was that a Telegram message got no reply and no surface, log line
 * or notification said why. So the daemon watches the states it now reports
 * truthfully, and when one stops working it says so over a channel that still
 * does.
 *
 * Composed here rather than in facade-composition.ts because the announcer is
 * a policy, which surfaces may carry an unprompted alert, and what happens
 * when none can, and policies deserve a file a reader can find.
 */
import { ChannelHealthWatcher, isChannelWorking } from '../channels/index.js';
import type { ChannelDeliveryTarget, ChannelIngressAlarm } from '../channels/index.js';
import { deliverOwnerAlert, type OwnerAlertDelivery } from './owner-alert.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { ResolvedDaemonFacadeRuntime } from './facade-types.js';

/**
 * Surfaces an unprompted alert may be pushed to.
 *
 * `tui` and `web` are excluded because they are PULL surfaces, nothing is
 * delivered to them, they are read when the owner happens to look, which is the
 * property that made the original defect invisible in the first place.
 * `webhook` is excluded because its target is whatever endpoint the operator
 * wired, which is not necessarily a place a person reads.
 */
const DELIVERABLE_ALERT_SURFACES = new Set<string>([
  'slack', 'discord', 'ntfy', 'telegram', 'google-chat', 'signal', 'whatsapp',
  'telephony', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix', 'homeassistant',
]);

/**
 * Watch the channels, and tell the owner over one that still works when another
 * stops.
 *
 * The announcer re-reads the registry rather than trusting a cached picture:
 * the point of the message is that something just changed, and the set of
 * channels able to carry it is exactly what changed. It excludes the failed
 * surface, because announcing a dead Telegram over Telegram is the failure
 * wearing the alert's clothes.
 *
 * When no other surface carries it, the alert goes the owner-alert way: the
 * owner's own conversation on the failing surface first (a surface that cannot
 * process what it receives can usually still send), then a daemon receipt the
 * next attached terminal or web UI shows.
 *
 * The ingress alarm wakes the watcher as soon as a surface starts or stops
 * failing to process what arrives, so that news does not wait for a sweep.
 */
export function buildDaemonChannelHealthWatcher(
  runtime: ResolvedDaemonFacadeRuntime,
  owner?: { readonly delivery: OwnerAlertDelivery; readonly ingressAlarm?: ChannelIngressAlarm | undefined },
): ChannelHealthWatcher {
  const deliveryRouter = runtime.deliveryManager.getDeliveryRouter();
  const watcher = new ChannelHealthWatcher({
    listStatus: () => runtime.channelPlugins.listStatus(),
    // A surface that starts working or failing is published, so a client of surfaces.list hears it without polling.
    runtimeBus: runtime.runtimeBus,
    announce: async (alert, signal) => {
      const candidates = (await runtime.channelPlugins.listStatus()).filter((entry) =>
        entry.surface !== alert.surface
        && entry.enabled
        && DELIVERABLE_ALERT_SURFACES.has(entry.surface));
      // A surface served by an inbound webhook cannot be observed running, so it reads `unknown`
      // though it is configured and not failing. Confirmed-working carriers go first; these are the fallback.
      const confirmed = candidates.filter((entry) => isChannelWorking(entry.state));
      const unconfirmed = candidates.filter((entry) => entry.state === 'unknown');
      const ownerFallback = async (): Promise<boolean> => {
        if (!owner) return false;
        // Delivered on the owner's conversation, or kept as a receipt and logged.
        await deliverOwnerAlert(runtime.routeBindings, owner.delivery, alert.surface, alert.message);
        return true;
      };
      if (confirmed.length === 0 && unconfirmed.length === 0) {
        if (await ownerFallback()) return true;
        logger.error('A channel changed state and no surviving channel could carry the notice', {
          surface: alert.surface,
          state: alert.state,
          detail: alert.message,
          action: 'configure and enable a second channel so a dead one can be reported over another',
        });
        return false;
      }
      const deliverOver = async (carriers: typeof candidates): Promise<boolean> => {
        // One carrier that takes the notice is enough: trying the rest would tell the owner again
        // on every one of them, and a retried alert would repeat that.
        for (const carrier of carriers) {
          if (signal?.aborted) return false;
          try {
            await deliveryRouter.deliver({
              target: { kind: 'surface', surfaceKind: carrier.surface as ChannelDeliveryTarget['surfaceKind'] },
              body: alert.message,
              title: alert.kind === 'recovered' ? 'Channel recovered' : 'Channel not working',
              jobId: 'channel-health',
              runId: `channel-health-${alert.surface}-${Date.now()}`,
              includeLinks: false,
              ...(signal ? { signal } : {}),
            });
            return true;
          } catch (error) {
            logger.warn('Channel health notice could not be delivered over one surface', {
              surface: carrier.surface,
              about: alert.surface,
              error: summarizeError(error),
            });
          }
        }
        return false;
      };
      const delivered = await deliverOver(confirmed) || await deliverOver(unconfirmed);
      return delivered || (!signal?.aborted && await ownerFallback());
    },
  });
  owner?.ingressAlarm?.subscribe(() => watcher.requestSweep());
  return watcher;
}
