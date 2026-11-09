import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../../lib/client-lifetime';
import { sdk } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { SettingsBlock } from './dialog/parts';

const statusKey = ['watchers', 'triggers', 'execution-status'] as const;
/** The daemon's real surface supervisor, separate from workflow event triggers.
 * Inspect first; migrating always needs an explicit operator statement. */
export function TriggerRecoverySettings() {
  const acknowledgement = useRef<object | null>({});
  useEffect(() => { acknowledgement.current = {}; return () => { acknowledgement.current = null; }; }, []);
  const [closedOlder, setClosedOlder] = useState(false), confirm = useConfirm(), queryClient = useQueryClient();
  const retireAcknowledgement = () => { acknowledgement.current = {}; setClosedOlder(false); };
  const status = useQuery({ queryKey: statusKey, queryFn: async () => {
    const lifetime = getClientLifetime(), result = await sdk.operator.watchers.triggers.status();
    if (!isClientLifetimeCurrent(lifetime)) throw new Error('The selected host or operator changed. Refresh trigger status.');
    return { ...result, lifetime };
  } });
  useEffect(() => subscribeClientLifetime(() => { acknowledgement.current = {}; setClosedOlder(false); void queryClient.invalidateQueries({ queryKey: statusKey }); }), [queryClient]);
  const migrate = useMutation({
    mutationFn: async ({ lifetime, gesture }: { lifetime: ClientLifetime; gesture: object }) => {
      if (acknowledgement.current !== gesture || !isClientLifetimeCurrent(lifetime)) throw new Error('The selected host or operator changed. Refresh trigger status.');
      const result = await sdk.operator.watchers.triggers.migrate({ olderInstancesClosed: true, confirm: true });
      if (acknowledgement.current !== gesture || !isClientLifetimeCurrent(lifetime)) throw new Error('The host changed before migration could be confirmed. Refresh trigger status.');
      return { ...result, lifetime, gesture };
    },
    onSuccess: async result => { if (acknowledgement.current !== result.gesture || !isClientLifetimeCurrent(result.lifetime)) return; retireAcknowledgement(); queryClient.setQueryData(statusKey, { ...result.status, lifetime: result.lifetime }); await queryClient.invalidateQueries({ queryKey: statusKey }); },
  });
  const act = async () => {
    if (!closedOlder || !status.data?.migrationRequired || migrate.isPending) return;
    const lifetime = status.data.lifetime, gesture = acknowledgement.current;
    if (!gesture) return;
    if (!isClientLifetimeCurrent(lifetime)) { retireAcknowledgement(); return; }
    const accepted = await confirm.ask({ title: 'Migrate this daemon’s supervised triggers?',
      description: `You state that all older GoodVibes instances using this surface are closed. ${status.data.records.length} saved trigger(s) will move to the current supervisor. This statement is not an operating-system liveness check.`,
      confirmLabel: 'Migrate triggers' });
    if (accepted && closedOlder && acknowledgement.current === gesture && isClientLifetimeCurrent(lifetime)) migrate.mutate({ lifetime, gesture });
  };
  return <SettingsBlock title="Supervised trigger recovery" testId="trigger-recovery-settings"
    description="Inspect this daemon’s condition, stream and process-exit triggers. Workflow event triggers use a separate manager.">
    {confirm.element}
    {status.isPending ? <p>Reading trigger state…</p> : status.isError ? <p role="alert">{formatError(status.error)}</p> : status.data && <>
      <p>{status.data.message}</p>
      {status.data.records.length > 0 && <ul>{status.data.records.map(record => <li key={record.id}><strong>{record.label}</strong> — {record.kind} / {record.state}</li>)}</ul>}
      {status.data.migrationRequired && <>
        <label><input type="checkbox" checked={closedOlder} disabled={migrate.isPending} onChange={event => { acknowledgement.current = {}; setClosedOlder(event.target.checked); }} /> I closed all older GoodVibes instances using these triggers.</label>
        <Button disabled={!closedOlder || migrate.isPending} onClick={() => void act()}>{migrate.isPending ? 'Migrating…' : 'Migrate supervised triggers'}</Button>
      </>}
    </>}
    {migrate.isError && <p role="alert">{formatError(migrate.error)}</p>}
    <Button disabled={status.isFetching || migrate.isPending} onClick={() => { retireAcknowledgement(); void status.refetch(); }}>Refresh trigger status</Button>
  </SettingsBlock>;
}
