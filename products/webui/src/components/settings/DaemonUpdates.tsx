/**
 * DaemonUpdates, what the connected daemon says about keeping itself current
 * (`update.status`): whether its update loop is on and why not, checks that
 * keep failing, a release that is downloaded and waiting (since when, and
 * behind which work), a release it rejected, and an interrupted update that
 * stopped the loop. "Check now" runs one `update.check`, which never forces an
 * install. Without this, a daemon that cannot update itself looks exactly like
 * one with nothing to update to.
 *
 * Built like MemoryDiagnostics: the verb carries no settings schema, so it is
 * its own panel. A daemon that does not serve the verb gets an honest state,
 * never placeholder values.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { client as platformClient } from '../../lib/goodvibes';
import { isMethodNotInvokableError, isMethodUnavailableError } from '../../lib/errors';
import { asRecord } from '../../lib/object';
import { EmptyState } from '../feedback/EmptyState';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import { Button } from '../ui/Button';
import { SettingRow, SettingsBlock } from './dialog/parts';

const UPDATE_STATUS_KEY = ['update', 'status'] as const;

interface DaemonUpdateView {
  readonly armed: boolean;
  readonly offReason: string;
  readonly currentVersion: string | null;
  readonly checkIntervalMs: number | null;
  readonly failedCheckCount: number;
  readonly lastCheckFailure: string | null;
  readonly pendingVersion: string | null;
  readonly pendingSince: number | null;
  readonly pendingBlockedBy: readonly string[];
  readonly rejectedVersion: string | null;
  readonly recoveryRequired: boolean;
  readonly recoveryOperation: string | null;
  readonly check: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The wire answer read field by field; a body without `armed` is not an update status. */
function readUpdateView(raw: unknown): DaemonUpdateView | null {
  const record = asRecord(raw);
  if (typeof record.armed !== 'boolean') return null;
  const recovery = record.transactionRecovery && typeof record.transactionRecovery === 'object' ? asRecord(record.transactionRecovery) : null;
  return {
    armed: record.armed,
    offReason: text(record.offReason) ?? '',
    currentVersion: text(record.currentVersion),
    checkIntervalMs: count(record.checkIntervalMs),
    failedCheckCount: count(record.failedCheckCount) ?? 0,
    lastCheckFailure: text(record.lastCheckFailure),
    pendingVersion: text(record.pendingVersion),
    pendingSince: count(record.pendingSince),
    pendingBlockedBy: Array.isArray(record.pendingBlockedBy) ? record.pendingBlockedBy.filter((id): id is string => typeof id === 'string') : [],
    rejectedVersion: text(record.rejectedVersion),
    recoveryRequired: record.recoveryRequired === true || recovery !== null,
    recoveryOperation: text(recovery?.operation),
    check: text(record.check),
  };
}

function elapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

async function readStatus(method: 'update.status' | 'update.check'): Promise<DaemonUpdateView> {
  const raw: unknown = method === 'update.check'
    ? await platformClient.operator.invoke('update.check', {})
    : await platformClient.operator.invoke('update.status', {});
  const view = readUpdateView(raw);
  if (!view) throw new Error(`The daemon answered ${method}, but the answer did not carry an update status.`);
  return view;
}

const CHECK_OUTCOME: Record<string, string> = {
  ran: 'A check ran now; the rows above are its result.',
  'already-in-flight': 'Another check was already running, so none was started; the rows above are as of now.',
  'loop-off': 'No check ran: the update loop is off.',
  installing: 'A newer release was found; the daemon is installing it now and will restart into it. It stops answering for a short while.',
};

export function DaemonUpdates() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: UPDATE_STATUS_KEY, queryFn: () => readStatus('update.status'), staleTime: 30_000, retry: false });
  const check = useMutation({
    mutationFn: () => readStatus('update.check'),
    onSuccess: (view) => { queryClient.setQueryData(UPDATE_STATUS_KEY, view); },
  });
  const unavailable = status.isError && (isMethodUnavailableError(status.error) || isMethodNotInvokableError(status.error));
  const view = status.data;

  return (
    <SettingsBlock
      title="Daemon updates"
      description="Whether the daemon keeps itself current, and what is holding it back."
      testId="daemon-updates"
      actions={view && view.armed ? (
        <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} disabled={check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? 'Checking…' : 'Check now'}
        </Button>
      ) : undefined}
    >
      {status.isPending && <div aria-busy="true" aria-label="Loading daemon update status"><SkeletonBlock variant="text" lines={2} /></div>}
      {unavailable && (
        <EmptyState
          title="This daemon does not report its updates"
          description="The connected daemon build has no update status. Update it by running the GoodVibes installer again on the daemon's machine, then it shows here."
        />
      )}
      {status.isError && !unavailable && <ErrorState error={status.error} onRetry={() => void status.refetch()} title="Daemon update status unavailable" />}
      {view && (
        <div className="settings-rows">
          <SettingRow
            label="Self-update"
            description={view.armed
              ? (view.checkIntervalMs !== null ? `Checks every ${elapsed(view.checkIntervalMs)}.` : 'Checks on a schedule.')
              : (view.offReason || 'The update loop is not running.')}
            control={<span className="settings-row__value">{view.armed ? 'On' : 'Off'}</span>}
          />
          {view.currentVersion && (
            <SettingRow label="Running" control={<span className="settings-row__value">{view.currentVersion}</span>} />
          )}
          {view.failedCheckCount > 0 && (
            <SettingRow
              label="Failing checks"
              description={view.lastCheckFailure ?? 'The most recent check failed.'}
              control={<span className="settings-row__value">{view.failedCheckCount} in a row</span>}
            />
          )}
          {view.pendingVersion && view.check !== 'installing' && (
            <SettingRow
              label="Waiting to install"
              description={[
                'Downloaded and verified.',
                view.pendingSince !== null ? `Waiting ${elapsed(Date.now() - view.pendingSince)}.` : '',
                view.pendingBlockedBy.length > 0
                  ? `It installs when this work finishes: ${view.pendingBlockedBy.join(', ')}.`
                  : 'It installs when no work is in flight.',
              ].filter(Boolean).join(' ')}
              control={<span className="settings-row__value">{view.pendingVersion}</span>}
            />
          )}
          {view.rejectedVersion && (
            <SettingRow
              label="Rejected"
              description="It crash looped and was rolled back; the update loop will not install it again."
              control={<span className="settings-row__value">{view.rejectedVersion}</span>}
            />
          )}
          {view.recoveryRequired && (
            <SettingRow
              label="Recovery needed"
              description={`An interrupted ${view.recoveryOperation ?? 'update'} stopped the update loop; it stays off until the kept files are dealt with. Run goodvibes-daemon update on the daemon's machine to see them.`}
              control={<span className="settings-row__value">Loop stopped</span>}
            />
          )}
          {check.data?.check && CHECK_OUTCOME[check.data.check] && (
            <p className="settings-block__description" role="status">{CHECK_OUTCOME[check.data.check]}</p>
          )}
          {check.isError && <ErrorState error={check.error} title="The check did not run" />}
        </div>
      )}
    </SettingsBlock>
  );
}
