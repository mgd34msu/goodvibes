import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from '../../lib/client-lifetime';
import { client as platformClient } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { Button } from '../ui/Button';
import { SettingsBlock } from './dialog/parts';

const statusKey = ['watchers', 'triggers', 'execution-status'] as const;
/** The daemon's real surface supervisor, separate from workflow event triggers. */
export function TriggerRecoverySettings() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: statusKey, queryFn: async () => {
    const lifetime = getClientLifetime(), result = await platformClient.operator.watchers.triggers.status();
    if (!isClientLifetimeCurrent(lifetime)) throw new Error('The selected host or operator changed. Refresh trigger status.');
    return result;
  } });
  useEffect(() => subscribeClientLifetime(() => { void queryClient.invalidateQueries({ queryKey: statusKey }); }), [queryClient]);
  return <SettingsBlock title="Supervised triggers" testId="trigger-recovery-settings"
    description="Inspect this daemon’s condition, stream and process-exit triggers. Workflow event triggers use a separate manager.">
    {status.isPending ? <p>Reading trigger state…</p> : status.isError ? <p role="alert">{formatError(status.error)}</p> : status.data && <>
      <p>{status.data.message}</p>
      {status.data.records.length > 0 && <ul>{status.data.records.map(record => <li key={record.id}><strong>{record.label}</strong> — {record.kind} / {record.state}</li>)}</ul>}
    </>}
    <Button disabled={status.isFetching} onClick={() => { void status.refetch(); }}>Refresh trigger status</Button>
  </SettingsBlock>;
}
