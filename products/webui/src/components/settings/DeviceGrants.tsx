/**
 * DeviceGrants, the grants surface for paired-phone capabilities.
 *
 * The owner's ruling of 2026-07-25 requires that "always allow" be "a durable
 * per-capability, per-node grant, visible and revocable in the grants surface".
 * This panel is that surface: every durable grant with the device it belongs
 * to, the capability it covers, when it was given, when it expires, and how
 * often it has been used, each with a revoke control, plus the recent ledger
 * of grants given, used, revoked, and expired, and a control to run the
 * housekeeping sweep and read back exactly what it removed. Beside the grants,
 * the photos and screen captures the daemon is keeping, each with a delete
 * control, so a capture is gone when the owner says so rather than when its
 * retention window ends.
 *
 * It renders from devices.grants.list / devices.grants.revoke /
 * devices.artifacts.list / devices.artifacts.delete /
 * devices.housekeeping.run, so it shows the daemon's own record rather than a
 * client-side mirror that could disagree with what is actually honoured.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { invokeMethod } from '../../lib/goodvibes';
import type { OperatorMethodOutput } from '../../lib/goodvibes';
import { formatError, isMethodUnavailableError } from '../../lib/errors';
import { EmptyState } from '../feedback/EmptyState';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { Disclosure } from '../data-view/DataView';
import { Row, RowList } from '../ui/Row';
import { SettingsBlock } from './dialog/parts';
import { whenLabel } from '../../lib/when-label';
import '../../styles/components/device.css';

type GrantsResult = OperatorMethodOutput<'devices.grants.list'>;
type NodesResult = OperatorMethodOutput<'devices.nodes.list'>;
type HousekeepingResult = OperatorMethodOutput<'devices.housekeeping.run'>;
type CapturesResult = OperatorMethodOutput<'devices.artifacts.list'>;

export const deviceGrantsQueryKey = ['devices', 'grants'] as const;
export const deviceNodesQueryKey = ['devices', 'nodes'] as const;
export const deviceCapturesQueryKey = ['devices', 'captures'] as const;

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

/** A time for a grant line; a missing time reads "never". */
function formatWhen(value: number | null | undefined): string {
  return whenLabel(value) || 'never';
}

const TITLE = 'Phone capability grants';

/** Grant activity rows drawn at first, and how many more each "Show older" adds. */
const AUDIT_PAGE = 25;

export function DeviceGrants() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [sweep, setSweep] = useState<HousekeepingResult | null>(null);
  // Grant activity rows drawn; "Show older" draws the next ones from the list already read.
  const [auditShown, setAuditShown] = useState(AUDIT_PAGE);

  const grants = useQuery<GrantsResult>({
    queryKey: deviceGrantsQueryKey,
    queryFn: () => invokeMethod('devices.grants.list', {}),
  });
  const nodes = useQuery<NodesResult>({
    queryKey: deviceNodesQueryKey,
    queryFn: () => invokeMethod('devices.nodes.list', {}),
  });

  const revoke = useMutation({
    mutationFn: (grantId: string) => invokeMethod('devices.grants.revoke', { grantId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: deviceGrantsQueryKey });
      void queryClient.invalidateQueries({ queryKey: deviceNodesQueryKey });
    },
    // A refused revoke leaves the grant in force; re-read so the list shows what the daemon honours.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: deviceGrantsQueryKey });
    },
  });

  /** Revoking is one-way: the confirm carries the warning, the row button stays quiet. */
  async function handleRevoke(grant: { grantId: string; capabilityTitle: string }): Promise<void> {
    const ok = await confirm.ask({
      title: 'Revoke this grant?',
      target: grant.capabilityTitle,
      description: 'The phone asks again the next time it needs this.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    revoke.reset();
    revoke.mutate(grant.grantId);
  }

  const housekeeping = useMutation({
    mutationFn: () => invokeMethod('devices.housekeeping.run', {}),
    onSuccess: (result) => {
      setSweep(result);
      void queryClient.invalidateQueries({ queryKey: deviceGrantsQueryKey });
      void queryClient.invalidateQueries({ queryKey: deviceCapturesQueryKey });
    },
  });

  const captures = useQuery<CapturesResult>({
    queryKey: deviceCapturesQueryKey,
    queryFn: () => invokeMethod('devices.artifacts.list', {}),
  });
  const [deleted, setDeleted] = useState<string | null>(null);
  const deleteCapture = useMutation({
    mutationFn: (artifactId: string) => invokeMethod('devices.artifacts.delete', { artifactId }),
    onSuccess: (result) => {
      setDeleted(result.deleted ? `Capture deleted (${formatBytes(result.removal.byteLength)}).` : result.detail);
      void queryClient.invalidateQueries({ queryKey: deviceCapturesQueryKey });
    },
    // A refused delete may mean it was already swept; re-read so the list shows what the daemon keeps.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: deviceCapturesQueryKey });
    },
  });

  /** Deleting is one-way: the confirm carries the warning. */
  async function handleDeleteCapture(capture: { artifactId: string; capabilityId: string }): Promise<void> {
    const ok = await confirm.ask({
      title: 'Delete this capture?',
      target: capture.capabilityId,
      description: 'The photo or screen capture is removed from the daemon host now and cannot be recovered.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    deleteCapture.reset();
    setDeleted(null);
    deleteCapture.mutate(capture.artifactId);
  }

  if (grants.isPending) {
    return (
      <SettingsBlock title={TITLE}>
        <div aria-label="Loading device grants" aria-busy="true">
          <SkeletonBlock variant="text" lines={3} />
        </div>
      </SettingsBlock>
    );
  }

  if (grants.isError) {
    // A daemon that predates this feature answers "method unavailable"; that is
    // an honest "not on this daemon yet", not an error state to alarm anyone.
    if (isMethodUnavailableError(grants.error)) {
      return (
        <SettingsBlock title={TITLE}>
          <EmptyState
            title="Not available on this daemon"
            description="This daemon does not serve the paired-phone capability verbs yet. Update it to manage phone grants here."
          />
        </SettingsBlock>
      );
    }
    return (
      <SettingsBlock title={TITLE}>
        <ErrorState error={grants.error} title="Device grants unavailable" onRetry={() => void grants.refetch()} />
      </SettingsBlock>
    );
  }

  // A daemon that answers without these lists reads as "none yet", never a crash.
  const rows = Array.isArray(grants.data.grants) ? grants.data.grants : [];
  const audit = Array.isArray(grants.data.audit) ? grants.data.audit : [];
  const nodeLabels = new Map((nodes.data?.nodes ?? []).map((node) => [node.nodeId, node.label]));

  return (
    <SettingsBlock
      className="device-grants"
      title={TITLE}
      description={(
        <>
          Every capability asks before it runs. Choosing &quot;always allow&quot; on that prompt
          writes one durable grant for that one capability on that one phone, listed here, and
          revocable here. Revoking deletes the grant, so the next request asks again.
          {nodes.data ? ` Captures are kept by the daemon for ${String(nodes.data.captureRetentionHours)} hours; the phone's browser keeps no copy.` : ''}
        </>
      )}
      actions={(
        <div className="device-panel__actions">
          <Button size="sm" icon={<RefreshCw aria-hidden="true" />} onClick={() => void grants.refetch()} disabled={grants.isFetching}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => housekeeping.mutate()} disabled={housekeeping.isPending}>
            Run housekeeping now
          </Button>
        </div>
      )}
    >
      {confirm.element}
      {revoke.isError ? (
        <div className="banner warning" role="alert">
          Revoke failed, the grant is still in force: {formatError(revoke.error)}
        </div>
      ) : null}
      {housekeeping.isError ? (
        <div className="banner warning" role="alert">{formatError(housekeeping.error)}</div>
      ) : null}
      {sweep ? (
        <p className="device-panel__result" aria-live="polite">{sweep.summary}</p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Smartphone size={28} />}
          title="No durable grants"
          description='Nothing has been granted "always allow" yet. Every phone capability is asking each time.'
        />
      ) : (
        <RowList aria-label="Durable grants">
          {rows.map((grant) => (
            <Row
              key={grant.grantId}
              title={grant.capabilityTitle}
              meta={[
                `${nodeLabels.get(grant.nodeId) ?? grant.nodeId} · ${grant.nodeKind}`,
                `Granted ${formatWhen(grant.grantedAt)}`,
                `expires ${formatWhen(grant.expiresAt)}`,
                `used ${String(grant.useCount)} time${grant.useCount === 1 ? '' : 's'}`,
                `last used ${formatWhen(grant.lastUsedAt)}`,
              ].join(' · ')}
              trailing={(
                <Button
                  variant="quiet-danger"
                  size="sm"
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() => void handleRevoke(grant)}
                  disabled={revoke.isPending}
                  aria-label={`Revoke ${grant.capabilityTitle}`}
                >
                  Revoke
                </Button>
              )}
            />
          ))}
        </RowList>
      )}

      <h4 className="device-panel__subhead">Captures kept on the daemon</h4>
      {deleteCapture.isError ? (
        <div className="banner warning" role="alert">
          Delete failed, the capture may still be kept: {formatError(deleteCapture.error)}
        </div>
      ) : null}
      {deleted ? <p className="device-panel__result" aria-live="polite">{deleted}</p> : null}
      {captures.isError ? (
        isMethodUnavailableError(captures.error)
          ? <p className="device-panel__result">This daemon does not list retained captures yet.</p>
          : <ErrorState error={captures.error} title="Captures unavailable" onRetry={() => void captures.refetch()} />
      ) : (captures.data?.artifacts ?? []).length === 0 ? (
        <EmptyState
          icon={<Smartphone size={28} />}
          title="No captures kept"
          description="Photos and screen captures from a phone appear here until they are deleted or their retention window ends."
        />
      ) : (
        <RowList aria-label="Captures kept on the daemon">
          {(captures.data?.artifacts ?? []).map((capture) => (
            <Row
              key={capture.artifactId}
              title={`${capture.capabilityId} · ${nodeLabels.get(capture.nodeId) ?? capture.nodeId}`}
              meta={[
                `Taken ${formatWhen(capture.capturedAt)}`,
                `deleted ${formatWhen(capture.expiresAt)}`,
                formatBytes(capture.byteLength),
                ...(capture.reason ? [capture.reason] : []),
              ].join(' · ')}
              trailing={(
                <Button
                  variant="quiet-danger"
                  size="sm"
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() => void handleDeleteCapture(capture)}
                  disabled={deleteCapture.isPending}
                  aria-label={`Delete capture ${capture.artifactId}`}
                >
                  Delete
                </Button>
              )}
            />
          ))}
        </RowList>
      )}

      {audit.length > 0 ? (
        <Disclosure summary={`Recent grant activity (${audit.length})`}>
          <RowList aria-label="Recent grant activity">
            {audit.slice(-auditShown).reverse().map((entry) => (
              <Row
                key={entry.id}
                title={`${entry.action} · ${entry.capabilityId}`}
                meta={`${nodeLabels.get(entry.nodeId) ?? entry.nodeId}${entry.reason ? ` · ${entry.reason}` : ''}`}
                trailing={<span className="device-panel__when">{whenLabel(entry.at)}</span>}
              />
            ))}
            {audit.length > auditShown && (
              <Row
                title="Show older"
                meta={`${audit.length - auditShown} more`}
                onSelect={() => setAuditShown((shown) => shown + AUDIT_PAGE)}
              />
            )}
          </RowList>
        </Disclosure>
      ) : null}
    </SettingsBlock>
  );
}
