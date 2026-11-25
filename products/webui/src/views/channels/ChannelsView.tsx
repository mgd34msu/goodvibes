/**
 * Channels, the Channels tab of Personal: the daemon's one set of channels
 * (Slack, Telegram, ntfy, ...), each with one state (working, needs a look,
 * not working, not set up, switched off) and why under any that is not
 * working, the same words the terminal programs' Mail, calendar and channels
 * place shows (platform channels/channel-state.ts, one definition).
 *
 * The list is `channels.status`, read again when the daemon announces a
 * channel switched on or off, connected or degraded (the `surfaces` frame,
 * hooks/useRealtimeInvalidation.ts). Every action is on the selected channel
 * and only in the states where it applies: a test message for a channel that
 * works, the daemon's checks for one that does not, and what it needs to be
 * set up for any. Pressing one is the owner's own request (invokeOwnerMethod).
 */
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { RadioTower } from 'lucide-react';
import { CHANNEL_STATE_WORDS, channelReasonOf, channelStateOf, type ChannelState } from '@goodvibes/engine/platform/platform/channels/channel-state';
import { invokeOwnerMethod } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { DetailPane, DetailSection, EmptyState, ListDetail, SkeletonRows } from '../../components/data-view/DataView';
import { Button, Row, RowList, StatusDot, type StatusTone } from '../../components/ui';
import ErrorBoundary from '../../components/feedback/ErrorBoundary';
import { ErrorState } from '../../components/feedback/ErrorState';
import { PersonalPage } from '../personal/PersonalPage';

/** The query key the `surfaces` frame invalidates. */
export const CHANNEL_STATUS_KEY = ['channels', 'status'] as const;

type JsonRecord = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

interface ChannelItem {
  readonly id: string;
  readonly label: string;
  readonly state: ChannelState;
  readonly reason?: string;
}

const TONE: Readonly<Record<ChannelState, StatusTone>> = {
  working: 'ok', 'needs-attention': 'warn', 'not-working': 'bad', 'not-set-up': 'idle', off: 'idle', unknown: 'info',
};
const TROUBLED: ReadonlySet<ChannelState> = new Set(['needs-attention', 'not-working', 'unknown']);

function channelsOf(body: unknown): readonly ChannelItem[] {
  const list = isRecord(body) && Array.isArray(body['channels']) ? body['channels'].filter(isRecord) : [];
  return list.flatMap((channel): ChannelItem[] => {
    const id = text(channel['surface']);
    if (!id) return [];
    const reason = channelReasonOf(channel);
    return [{ id, label: text(channel['label']) || id, state: channelStateOf(channel), ...(reason ? { reason } : {}) }];
  });
}

/** What one of the daemon's answers says, in lines a person reads. */
function resultLines(action: 'test' | 'doctor' | 'setup', body: unknown): readonly string[] {
  const root = isRecord(body) ? body : {};
  if (action === 'test') {
    return root['delivered'] === true
      ? [`Delivered${text(root['address']) ? ` to ${text(root['address'])}` : ''}.`]
      : [`Not delivered: ${text(root['error']) || 'the daemon gave no reason'}.`];
  }
  if (action === 'doctor') {
    const checks = Array.isArray(root['checks']) ? root['checks'].filter(isRecord) : [];
    const repairs = Array.isArray(root['repairActions']) ? root['repairActions'].filter(isRecord) : [];
    return [
      ...(checks.length === 0 ? ['No checks were reported.'] : checks.map((check) => `${text(check['label']) || text(check['id'])}: ${text(check['status'])}${text(check['detail']) ? `, ${text(check['detail'])}` : ''}`)),
      ...(repairs.length > 0 ? [`Repairs the daemon offers: ${repairs.map((repair) => text(repair['label']) || text(repair['id'])).join(', ')}.`] : []),
    ];
  }
  const fields = Array.isArray(root['fields']) ? root['fields'].filter(isRecord) : [];
  const secrets = Array.isArray(root['secretTargets']) ? root['secretTargets'].filter(isRecord) : [];
  return [
    ...(fields.length > 0 ? [`Settings: ${fields.map((field) => text(field['label']) || text(field['id'])).join(', ')}.`] : []),
    ...(secrets.length > 0 ? [`Secrets: ${secrets.map((target) => `${text(target['label']) || text(target['id'])}${target['required'] === true ? '' : ' (optional)'}`).join(', ')}.`] : []),
    ...(fields.length === 0 && secrets.length === 0 ? ['Nothing is declared.'] : []),
  ];
}

const METHOD = { test: 'channels.test.send', doctor: 'channels.doctor.get', setup: 'channels.setup.get' } as const;
const ACTION_WORDS = { test: 'Send a test message', doctor: 'Check it', setup: 'What it needs' } as const;

function ChannelPane({ channel, onClose }: { channel: ChannelItem; onClose: () => void }) {
  const run = useMutation({
    mutationFn: async (action: keyof typeof METHOD) => ({ action, body: await invokeOwnerMethod(METHOD[action], { surface: channel.id }) }),
  });
  const actions: (keyof typeof METHOD)[] = [
    ...(channel.state === 'working' ? ['test' as const] : []),
    ...(TROUBLED.has(channel.state) ? ['doctor' as const] : []),
    'setup',
  ];
  let outcome: ReactNode = null;
  if (run.isError) outcome = <p className="lib-quiet" role="alert">{formatError(run.error)}</p>;
  else if (run.data) {
    outcome = (
      <div role="status">
        <p className="lib-prose">{ACTION_WORDS[run.data.action]}:</p>
        {resultLines(run.data.action, run.data.body).map((line) => <p key={line} className="lib-prose">{line}</p>)}
      </div>
    );
  }
  return (
    <DetailPane title={channel.label} meta={CHANNEL_STATE_WORDS[channel.state]} onClose={onClose}>
      {channel.reason && (
        <DetailSection title="Why">
          <p className="lib-prose">{channel.reason}</p>
        </DetailSection>
      )}
      <DetailSection title="Actions">
        <div className="lib-actions">
          {actions.map((action) => (
            <Button key={action} size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate(action)}>
              {ACTION_WORDS[action]}
            </Button>
          ))}
        </div>
        {outcome}
      </DetailSection>
    </DetailPane>
  );
}

export function ChannelsView({ tabs }: { tabs?: ReactNode }) {
  const status = useQuery({ queryKey: CHANNEL_STATUS_KEY, queryFn: () => invokeOwnerMethod('channels.status', {}), retry: false });
  const [selected, setSelected] = useState<string | null>(null);
  const channels = channelsOf(status.data);
  const open = channels.find((channel) => channel.id === selected);

  const list = (
    <>
      {status.isPending && <SkeletonRows count={4} label="Reading your channels" />}
      {status.error && <ErrorState error={status.error} onRetry={() => void status.refetch()} title="Could not read your channels" />}
      {!status.isPending && !status.error && channels.length === 0 && (
        <EmptyState icon={<RadioTower />} title="No channels">The daemon reports no channels.</EmptyState>
      )}
      {channels.length > 0 && (
        <RowList aria-label="Your channels">
          {channels.map((channel) => (
            <Row
              key={channel.id}
              title={channel.label}
              meta={CHANNEL_STATE_WORDS[channel.state]}
              leading={<StatusDot tone={TONE[channel.state]} />}
              selected={channel.id === selected}
              onSelect={() => setSelected(channel.id)}
            />
          ))}
        </RowList>
      )}
    </>
  );

  return (
    <PersonalPage tabs={tabs}>
      <ErrorBoundary fallback={(err, reset) => <ErrorState error={err} onRetry={reset} title="Channels failed" />}>
        <ListDetail
          mode="peek"
          list={list}
          detail={open ? <ChannelPane key={open.id} channel={open} onClose={() => setSelected(null)} /> : null}
          detailOpen={open !== undefined}
          onCloseDetail={() => setSelected(null)}
          listLabel="Channels"
          detailLabel="Channel"
          backLabel="All channels"
        />
      </ErrorBoundary>
    </PersonalPage>
  );
}
