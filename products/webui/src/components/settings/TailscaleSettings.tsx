/**
 * TailscaleSettings, the one confirmed action behind a "needs https, available
 * via tailscale" label, reachable from the browser instead of only the TUI
 * (tailscale.get / tailscale.serve.run, platform 1.8.0's LAN-http posture work).
 *
 * READ-ONLY detection first: tailscale.get reports whether the binary is present,
 * the node is logged in, and its MagicDNS name. This panel renders NOTHING while
 * that detection is pending or when tailscale is not a usable environment, no nag,
 * no dead button, matching the daemon's own "quiet when absent" contract. Only when
 * tailscale reports available && loggedIn && a resolvable httpsUrl does the one
 * action appear: "Serve over tailscale", behind the shared ConfirmSheet idiom (same
 * pattern as PairingTokensSettings' revoke/migrate actions).
 *
 * tailscale.serve.run is the ONE state-changing tailscale command the daemon ever
 * runs. The attempt is recorded with an honest receipt either way, a failure
 * renders the daemon's own detail text, never a generic error. On success the
 * resulting https MagicDNS URL renders as a real link, and the daemon's
 * web.publicBaseUrl updates to it (publicBaseUrlUpdated echoes whether that write
 * landed). A failed serve that printed a link to turn Serve on for the tailnet
 * (enableUrl) shows that link.
 *
 * While a serve this daemon started is on (activeServe), "Stop serving" runs
 * tailscale.serve.stop behind the same confirm; the daemon puts web.publicBaseUrl
 * back and its publicBaseUrlDetail says what happened to it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { StatusDot } from '../ui/StatusDot';
import { SettingsBlock } from './dialog/parts';
import { whenLabel } from '../../lib/when-label';
import '../../styles/components/tailscale.css';

export function TailscaleSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const detection = useQuery({
    queryKey: queryKeys.tailscale,
    queryFn: () => platformClient.operator.tailscale.get(),
  });

  const serveRun = useMutation({
    mutationFn: () => platformClient.operator.tailscale.serveRun(),
    onSuccess: async (result) => {
      toast(
        result.receipt.ok
          ? { title: 'Serving over tailscale', description: result.receipt.detail, tone: 'success' }
          : { title: 'Tailscale serve failed', description: result.receipt.detail, tone: 'danger' },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.tailscale });
    },
    onError: (error: unknown) => toast({ title: 'Tailscale serve failed', description: formatError(error), tone: 'danger' }),
  });

  const serveStop = useMutation({
    mutationFn: () => platformClient.operator.tailscale.serveStop(),
    onSuccess: async (result) => {
      toast(
        result.receipt.ok
          ? { title: 'Stopped serving over tailscale', description: result.publicBaseUrlDetail, tone: 'success' }
          : { title: 'Tailscale serve was not stopped', description: result.receipt.detail, tone: 'danger' },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.tailscale });
    },
    onError: (error: unknown) => toast({ title: 'Tailscale stop failed', description: formatError(error), tone: 'danger' }),
  });

  async function handleServe(): Promise<void> {
    const ok = await confirm.ask({
      title: 'Serve this daemon over Tailscale?',
      description: 'Tailscale serves it at its HTTPS address on your tailnet and handles the certificate, and running it again is safe.',
      confirmLabel: 'Serve over tailscale',
    });
    if (!ok) return;
    serveRun.mutate();
  }

  async function handleStop(): Promise<void> {
    const ok = await confirm.ask({
      title: 'Stop serving this daemon over Tailscale?',
      description: 'Its https tailnet address stops working, and links and pairing codes go back to the address used before.',
      confirmLabel: 'Stop serving',
    });
    if (!ok) return;
    serveStop.mutate();
  }

  // Quiet by construction: pending, errored, or genuinely absent all render nothing,
  // no nag, no dead button. A daemon build without tailscale.get at all (an older
  // daemon) also lands here since detection.data stays undefined.
  const usable = detection.data?.available && detection.data.loggedIn && detection.data.httpsUrl;
  // A serve this daemon started stays on in tailscaled until it is stopped, so
  // the stop stays reachable while tailscale answers, logged in or not.
  const activeServe = detection.data?.available ? detection.data.activeServe : undefined;
  if ((!usable && !activeServe) || !detection.data) return null;
  const busy = serveRun.isPending || serveStop.isPending;

  // Prefer the mutation's OWN just-returned receipt (instant, no refetch round-trip
  // needed) and fall back to the query's last-known receipt otherwise (e.g. on first
  // load, or after a page reload where a prior serve already ran). invalidateQueries
  // in the mutation's onSuccess still keeps the query itself in sync for any OTHER
  // consumer or a later remount.
  const mutationReceipts = [serveRun.data?.receipt, serveStop.data?.receipt]
    .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined);
  const lastServe = mutationReceipts.sort((a, b) => b.at - a.at)[0] ?? detection.data.lastServe;

  return (
    <SettingsBlock
      testId="tailscale-settings"
      title="Tailscale"
      description={(
        <>
          {detection.data.magicDnsName ? <>Connected as <strong>{detection.data.magicDnsName}</strong>. </> : `${detection.data.detail}. `}
          Serving over tailscale puts this
          daemon at an https address, the kind browser features like the camera and push need, without
          the daemon making its own certificate.
        </>
      )}
      actions={(
        <>
          {usable && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void handleServe()}
            >
              {serveRun.isPending ? 'Setting up…' : activeServe ? 'Serve over tailscale again' : 'Serve over tailscale'}
            </Button>
          )}
          {activeServe && (
            <Button
              disabled={busy}
              onClick={() => void handleStop()}
            >
              {serveStop.isPending ? 'Stopping…' : 'Stop serving'}
            </Button>
          )}
        </>
      )}
    >
      {confirm.element}

      {lastServe && (
        <div
          className={`tailscale-panel__receipt tailscale-panel__receipt--${lastServe.ok ? 'ok' : 'danger'}`}
          role="status"
        >
          <StatusDot tone={lastServe.ok ? 'ok' : 'bad'} />
          <span>
            {lastServe.ok && lastServe.url && lastServe.action !== 'stop' ? (
              <>
                Serving at{' '}
                <a href={lastServe.url} target="_blank" rel="noreferrer">{lastServe.url}</a>
              </>
            ) : (
              lastServe.detail
            )}
            {!lastServe.ok && lastServe.enableUrl && (
              <>
                {' '}
                <a href={lastServe.enableUrl} target="_blank" rel="noreferrer">Turn on Serve for your tailnet</a>
              </>
            )}
            {whenLabel(lastServe.at) ? ` · ${whenLabel(lastServe.at)}` : ''}
          </span>
        </div>
      )}

      {serveRun.isError && (
        <div className="banner warning" role="alert">{formatError(serveRun.error)}</div>
      )}
      {serveStop.isError && (
        <div className="banner warning" role="alert">{formatError(serveStop.error)}</div>
      )}
    </SettingsBlock>
  );
}
