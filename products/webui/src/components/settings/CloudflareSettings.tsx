/**
 * CloudflareSettings, the Cloudflare integration as the daemon reports it
 * (cloudflare.status), with the two actions that need no API token typed in the
 * browser: checking the deployed Worker (cloudflare.worker.verify) and turning
 * the integration off (cloudflare.disable, behind the confirm sheet).
 *
 * Provisioning is in Devices and network (the Cloudflare tab: create the token,
 * deploy), because it takes a Cloudflare API token; this panel says so when
 * nothing is set up instead of offering a button that cannot work.
 *
 * Every reading comes from the status document: a component reads as set up only
 * when a provision created or confirmed it, and `ready` already accounts for the
 * tunnel connector, so the panel decides nothing of its own.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeMethod } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { StatusDot, type StatusTone } from '../ui/StatusDot';
import { SettingRow, SettingsBlock } from './dialog/parts';

/** The components a provision can create, in the order the status lists them, with the job each does. */
const COMPONENTS: ReadonlyArray<{ readonly key: string; readonly label: string; readonly job: string }> = [
  { key: 'workerName', label: 'Worker', job: 'Takes batch jobs and calls this daemon.' },
  { key: 'queueName', label: 'Queues', job: 'Hold batch jobs and their dead letters.' },
  { key: 'tunnel', label: 'Tunnel', job: 'Reaches this daemon without opening a port.' },
  { key: 'access', label: 'Access', job: 'Lets only the Worker and your clients reach the daemon hostname.' },
  { key: 'kv', label: 'KV', job: 'Keeps queued-job state.' },
  { key: 'durableObjects', label: 'Durable Objects', job: 'Counts the daily queue budget.' },
  { key: 'r2', label: 'R2', job: 'Stores large job bodies.' },
  { key: 'secretsStore', label: 'Secrets Store', job: 'Holds the Worker\'s credentials.' },
];

interface TunnelConnectorView {
  readonly state: string;
  readonly detail: string;
  readonly next: readonly string[];
}

interface CloudflareStatusView {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly configured: Readonly<Record<string, boolean>>;
  readonly warnings: readonly string[];
  readonly tunnelConnector: TunnelConnectorView | null;
}

interface CheckView {
  readonly ok: boolean;
  readonly status: number | null;
  readonly error: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function readStatus(value: unknown): CloudflareStatusView {
  const body = record(value);
  const configured: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(record(body.configured))) configured[key] = flag === true;
  const connector = record(body.tunnelConnector);
  return {
    enabled: body.enabled === true,
    ready: body.ready === true,
    configured,
    warnings: strings(body.warnings),
    tunnelConnector: typeof connector.state === 'string'
      ? { state: connector.state, detail: typeof connector.detail === 'string' ? connector.detail : '', next: strings(connector.next) }
      : null,
  };
}

function readCheck(value: unknown): CheckView | null {
  const body = record(value);
  if (typeof body.ok !== 'boolean') return null;
  return {
    ok: body.ok,
    status: typeof body.status === 'number' ? body.status : null,
    error: typeof body.error === 'string' && body.error ? body.error : null,
  };
}

function checkLine(label: string, check: CheckView | null): string {
  if (!check) return `${label}: not checked`;
  if (check.ok) return `${label}: ok${check.status ? ` (HTTP ${check.status})` : ''}`;
  return `${label}: failed${check.status ? ` (HTTP ${check.status})` : ''}${check.error ? `, ${check.error}` : ''}`;
}

const CONNECTOR_TONE: Readonly<Record<string, StatusTone>> = {
  connected: 'ok',
  starting: 'info',
  'not-configured': 'idle',
  stopped: 'idle',
  'not-installed': 'warn',
  failed: 'bad',
};

export function CloudflareSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const status = useQuery({
    queryKey: queryKeys.cloudflare,
    queryFn: async () => readStatus(await invokeMethod('cloudflare.status', {})),
  });

  const verify = useMutation({
    mutationFn: async () => {
      const result = record(await invokeMethod('cloudflare.worker.verify', {}));
      return {
        ok: result.ok === true,
        lines: [checkLine('Worker health', readCheck(result.workerHealth)), checkLine('Worker to daemon', readCheck(result.daemonBatchProxy))],
      };
    },
    onSuccess: (result) => toast({
      title: result.ok ? 'The Worker reaches this daemon' : 'The Worker check failed',
      description: result.lines.join('\n'),
      tone: result.ok ? 'success' : 'danger',
    }),
    onError: (error: unknown) => toast({ title: 'The Worker check failed', description: formatError(error), tone: 'danger' }),
  });

  const disable = useMutation({
    mutationFn: async () => {
      const result = record(await invokeMethod('cloudflare.disable', {}));
      const steps = Array.isArray(result.steps) ? result.steps.map(record) : [];
      return {
        remoteDisabled: result.remote === 'disabled',
        stillDeployed: steps.filter((step) => step.name === 'still-deployed').map((step) => String(step.message ?? step.resourceId ?? '')).filter(Boolean),
        warnings: steps.filter((step) => step.status === 'warning' && step.name !== 'still-deployed').map((step) => String(step.message ?? step.name ?? '')).filter(Boolean),
      };
    },
    onSuccess: async (result) => {
      toast(result.remoteDisabled
        ? {
          title: 'Cloudflare is off',
          description: [
            'The Worker no longer holds the daemon credential, and its cron and workers.dev route are off.',
            result.stillDeployed.length > 0 ? `Still deployed at Cloudflare (delete in the dashboard if unwanted): ${result.stillDeployed.join('; ')}` : '',
          ].filter(Boolean).join('\n'),
          tone: 'success',
        }
        : {
          title: 'Cloudflare is off here, not at Cloudflare',
          description: [
            'This daemon stopped using the Worker, but the deployed Worker may keep calling it until you disable it in the Cloudflare dashboard.',
            ...result.warnings,
          ].join('\n'),
          tone: 'warning',
        });
      await queryClient.invalidateQueries({ queryKey: queryKeys.cloudflare });
    },
    onError: (error: unknown) => toast({ title: 'Cloudflare was not disabled', description: formatError(error), tone: 'danger' }),
  });

  async function handleDisable(): Promise<void> {
    const ok = await confirm.ask({
      title: 'Turn the Cloudflare integration off?',
      description: 'The integration is switched off in config, the batch queue goes back to local, this daemon\'s tunnel connector stops, and the Worker loses its daemon credential, cron and workers.dev route. Nothing is deleted at Cloudflare; Deploy, in Devices and network under Cloudflare, sets it up again.',
      confirmLabel: 'Turn off',
      tone: 'danger',
    });
    if (ok) disable.mutate();
  }

  if (status.isPending) {
    return (
      <SettingsBlock title="Cloudflare">
        <SkeletonBlock variant="text" lines={3} />
      </SettingsBlock>
    );
  }
  const view = status.data;
  if (status.error || !view) {
    return (
      <SettingsBlock title="Cloudflare">
        <ErrorState error={status.error} onRetry={() => void status.refetch()} title="Cloudflare status unavailable" />
      </SettingsBlock>
    );
  }

  const provisioned = COMPONENTS.filter((component) => view.configured[component.key]);
  const workerKnown = view.configured.workerName === true && view.configured.workerBaseUrl === true;

  if (!view.enabled && provisioned.length === 0) {
    return (
      <SettingsBlock
        testId="cloudflare-settings"
        title="Cloudflare"
        description="Not set up. Cloudflare can run batch jobs on a Worker and queues and reach this daemon through a tunnel behind Access. Set it up in Devices and network, under Cloudflare: create the API token, then deploy; both take a Cloudflare API token."
      />
    );
  }

  const connector = view.tunnelConnector;
  return (
    <SettingsBlock
      testId="cloudflare-settings"
      title="Cloudflare"
      description={view.ready
        ? 'On and ready: batch jobs go to the Worker and it reaches this daemon.'
        : view.enabled
          ? 'On, but not ready yet: the notes below say what is missing.'
          : 'Off. The resources below were provisioned and stay at Cloudflare until you delete them there.'}
      actions={view.enabled ? (
        <Button variant="quiet-danger" size="sm" disabled={disable.isPending} onClick={() => void handleDisable()}>
          {disable.isPending ? 'Turning off…' : 'Turn off'}
        </Button>
      ) : undefined}
    >
      {confirm.element}
      <div className="settings-rows" aria-live="polite">
        <SettingRow
          label="State"
          control={(
            <span className="settings-row__value">
              <StatusDot tone={view.ready ? 'ok' : view.enabled ? 'warn' : 'idle'} />
              {view.ready ? 'Ready' : view.enabled ? 'Not ready' : 'Off'}
            </span>
          )}
        />
        {provisioned.map((component) => (
          <SettingRow
            key={component.key}
            label={component.label}
            description={component.job}
            control={<span className="settings-row__value"><StatusDot tone="ok" />Provisioned</span>}
          />
        ))}
        {connector && (
          <SettingRow
            label="Tunnel connector"
            description={[connector.detail, connector.state !== 'connected' ? connector.next[0] : ''].filter(Boolean).join(' Next: ')}
            control={(
              <span className="settings-row__value">
                <StatusDot tone={CONNECTOR_TONE[connector.state] ?? 'info'} />
                {connector.state}
              </span>
            )}
          />
        )}
        {workerKnown && (
          <SettingRow
            label="Worker check"
            description="Calls the Worker's health route and its proxy back to this daemon. Changes nothing."
            control={(
              <Button size="sm" disabled={verify.isPending} onClick={() => verify.mutate()}>
                {verify.isPending ? 'Checking…' : 'Check'}
              </Button>
            )}
          />
        )}
      </div>
      {view.warnings.length > 0 && (
        <ul className="banner warning" role="status">
          {view.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
    </SettingsBlock>
  );
}
