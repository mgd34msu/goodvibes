/**
 * /cloudflare in a terminal, described once (command-actions/): inspect and
 * manage the optional Cloudflare batch/control-plane integration through the
 * daemon's Cloudflare routes. Shared by both terminal apps; each supplies the
 * route client for the daemon it talks to, where its settings are read, and
 * its setup screen if it has one. Each action's values are turned back into
 * its subcommand's declared flags and read by the one parser below, so a bad
 * value is refused before anything is sent.
 */
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { readRefusal } from '@goodvibes/engine/errors';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import type { ActionDescription, ActionValues, CommandActionContext, FixedChoice, InputDescription } from './command-actions/types.js';
import { choiceInput, doAction, readAction, textInput } from './described-command-kit.js';
import {
  CLOUDFLARE_COMPONENT_IDS,
  CLOUDFLARE_COMPONENT_LABELS,
  DEFAULT_CLOUDFLARE_COMPONENT_SELECTION,
  CloudflareDaemonRouteError,
  type CloudflareComponent,
  type CloudflareComponentSelection,
  type CloudflareDaemonClient,
  type CloudflareProvisionStep,
} from './cloudflare-control-plane.js';
import { parseDeclaredFlags, type DeclaredFlags, type ParsedDeclaredFlags } from './declared-flags.js';

type ParsedCloudflareArgs = ParsedDeclaredFlags;

const AUTH_FLAGS = ['account', 'account-id', 'token', 'token-env', 'token-ref'] as const;
const COMPONENT_FLAGS = ['component', 'no-component'] as const;
const ZONE_FLAGS = ['zone-id', 'zone', 'zone-name'] as const;
/** Every value of `--batch-mode` the daemon accepts. */
const BATCH_MODES = ['off', 'explicit', 'eligible-by-default'] as const;

/**
 * Each subcommand's flags, declared once: the parse, the unknown-flag refusal
 * and the "needs a value" refusal all come from this table. `components` says
 * whether bare words name components (`provision tunnel kv`). `--yes` is
 * accepted everywhere as the owner's answer given in advance.
 */
const SUBCOMMAND_FLAGS: Readonly<Record<string, DeclaredFlags & { readonly components: boolean }>> = {
  status: { values: [], booleans: ['yes'], components: false },
  show: { values: [], booleans: ['yes'], components: false },
  requirements: { values: [...COMPONENT_FLAGS], booleans: ['all', 'advanced', 'yes'], components: true },
  'create-token': {
    values: [...COMPONENT_FLAGS, ...ZONE_FLAGS, 'account', 'account-id', 'bootstrap-token', 'bootstrap-env'],
    booleans: ['all', 'advanced', 'new', 'yes'],
    components: true,
  },
  discover: { values: [...AUTH_FLAGS, ...COMPONENT_FLAGS, ...ZONE_FLAGS], booleans: ['fast', 'all', 'advanced', 'yes'], components: true },
  validate: { values: [...AUTH_FLAGS], booleans: ['yes'], components: false },
  provision: {
    values: [
      ...AUTH_FLAGS, ...COMPONENT_FLAGS, ...ZONE_FLAGS,
      'daemon-url', 'daemon-hostname', 'worker-name', 'worker-subdomain', 'worker-hostname', 'worker-url',
      'queue', 'queue-name', 'dlq', 'dead-letter-queue', 'tunnel-name', 'tunnel-id', 'tunnel-service-url', 'tunnel-token-ref',
      'access-app-id', 'access-service-token-id', 'access-service-token-ref', 'kv-namespace-name', 'kv-namespace-id',
      'do-namespace-name', 'durable-object-namespace-name', 'r2-bucket-name', 'secrets-store-name', 'secrets-store-id',
      'worker-cron', 'operator-token', 'operator-token-ref', 'worker-client-token', 'worker-client-token-ref', 'batch-mode',
    ],
    booleans: ['all', 'advanced', 'no-verify', 'no-store-token', 'no-workers-dev', 'yes'],
    components: true,
  },
  verify: { values: ['worker-url', 'worker-token', 'worker-token-ref'], booleans: ['yes'], components: false },
  disable: { values: [...AUTH_FLAGS, 'worker-name', 'bootstrap-token', 'bootstrap-env'], booleans: ['keep-cron', 'keep-worker-subdomain', 'yes'], components: false },
};
const CLOUDFLARE_USAGE = '/cloudflare lists its actions.';

/**
 * Parse one line against its subcommand's declared flags and refuse, before
 * any request, an unknown flag, a value flag with no value, a word that names
 * no component, an invalid --batch-mode and a --token-env/--bootstrap-env
 * naming a variable this app does not have.
 */
export function readCloudflareLine(
  subcommand: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly ok: true; readonly parsed: ParsedCloudflareArgs } | { readonly ok: false; readonly problem: string } {
  const spec = SUBCOMMAND_FLAGS[subcommand];
  if (!spec) return { ok: false, problem: CLOUDFLARE_USAGE };
  const parsed = parseDeclaredFlags(args, spec);
  if (!parsed.ok) return parsed;
  const words = spec.components ? [...parsed.positional, ...getFlagValues(parsed, 'component'), ...getFlagValues(parsed, 'no-component')] : [];
  const unknownComponents = words.filter((word) => normalizeComponent(word) === null);
  if (unknownComponents.length > 0) {
    return { ok: false, problem: `${unknownComponents.map((word) => `"${word}"`).join(', ')} ${unknownComponents.length === 1 ? 'names' : 'name'} no component. Components: ${CLOUDFLARE_COMPONENT_IDS.join(', ')}.` };
  }
  if (!spec.components && parsed.positional.length > 0) {
    return { ok: false, problem: `${subcommand} takes no arguments besides flags; "${parsed.positional.join(' ')}" was not understood.` };
  }
  const batchMode = getFlag(parsed, 'batch-mode');
  if (batchMode && !(BATCH_MODES as readonly string[]).includes(batchMode)) {
    return { ok: false, problem: `--batch-mode must be one of ${BATCH_MODES.join(', ')}; "${batchMode}" is not.` };
  }
  for (const key of ['token-env', 'bootstrap-env']) {
    const name = getFlag(parsed, key);
    if (name && !env[name]) {
      return { ok: false, problem: `--${key} ${name}: that variable is not set in this app's environment, so the stored credential would be used instead. Export it before starting the app, or pass the token with --${key === 'token-env' ? 'token' : 'bootstrap-token'}.` };
    }
  }
  return { ok: true, parsed };
}

/** What a terminal app supplies to /cloudflare. */
export interface CloudflareCommandPolicy<Context> {
  /** The daemon's Cloudflare routes as this app reaches them; throws when this app cannot say where the daemon is. */
  readonly client: (context: Context) => CloudflareDaemonClient;
  /** A setting as this app reads it, for the status lines. */
  readonly readSetting: (context: Context, key: 'batch.mode' | 'batch.queueBackend') => unknown;
  /** Opens this app's guided Cloudflare setup; returns false when the app has none. */
  readonly openSetup?: ((context: Context) => boolean) | undefined;
}

/** Runs one subcommand on a line already read against its declared flags; returns what it prints. */
async function runCloudflare<Context>(subcommand: string, parsed: ParsedCloudflareArgs, ctx: Context, policy: CloudflareCommandPolicy<Context>): Promise<string> {
  let client: CloudflareDaemonClient;
  try {
    client = policy.client(ctx);
  } catch (error) {
    throw commandRefusal(`Cloudflare is not reachable from here: ${formatCloudflareError(error)}`);
  }
  try {
      if (subcommand === 'status') {
        const status = await client.status();
        // A resource name has a default; it is shown only once a provision created or confirmed it.
        const provisioned = (key: string, value: unknown): string => status.configured[key] && value ? String(value) : '(not provisioned)';
        const connector = status.tunnelConnector;
        return [
          'Cloudflare Status',
          `  enabled: ${status.enabled ? 'yes' : 'no'}`,
          `  ready: ${status.ready ? 'yes' : 'no'}`,
          `  account: ${status.config.accountId || '(not set)'}`,
          `  token ref: ${status.config.apiTokenRef || '(CLOUDFLARE_API_TOKEN fallback)'}`,
          `  worker: ${provisioned('workerName', status.config.workerName)}`,
          `  worker URL: ${status.config.workerBaseUrl || '(not set)'}`,
          `  queue: ${provisioned('queueName', status.config.queueName)}`,
          `  DLQ: ${provisioned('deadLetterQueueName', status.config.deadLetterQueueName)}`,
          `  tunnel: ${provisioned('tunnel', status.config.tunnelName)} ${status.configured.tunnel && status.config.tunnelId ? `(${status.config.tunnelId})` : ''}`.trimEnd(),
          ...(connector ? [`  tunnel connector: ${connector.state} - ${connector.detail}`] : []),
          `  access app: ${provisioned('access', status.config.accessAppId)}`,
          `  kv: ${provisioned('kv', status.config.kvNamespaceName)}`,
          `  durable objects: ${provisioned('durableObjects', status.config.durableObjectNamespaceName)}`,
          `  r2: ${provisioned('r2', status.config.r2BucketName)}`,
          `  secrets store: ${provisioned('secretsStore', status.config.secretsStoreName)}`,
          `  batch mode: ${String(policy.readSetting(ctx, 'batch.mode') ?? 'off')}`,
          `  queue backend: ${String(policy.readSetting(ctx, 'batch.queueBackend') ?? 'local')}`,
          ...status.warnings.map((warning) => `  warning: ${warning}`),
        ].join('\n');
      }

      if (subcommand === 'requirements') {
        const result = await client.tokenRequirements({
          components: componentsFromArgs(parsed),
          includeBootstrap: true,
        });
        return [
          'Cloudflare Token Requirements',
          `  components: ${formatComponents(result.components)}`,
          '  permissions:',
          ...result.permissions.map((permission) => `    ${permission.scope}: ${permission.permission} (${permission.component}) - ${permission.reason}`),
          ...(result.bootstrapToken.instructions.length > 0
            ? ['  bootstrap token:', ...result.bootstrapToken.instructions.map((line) => `    ${line}`)]
            : []),
        ].join('\n');
      }

      if (subcommand === 'create-token') {
        const bootstrapToken = getFlag(parsed, 'bootstrap-token') || readTokenEnv(parsed, 'bootstrap-env');
        if (!bootstrapToken) throw commandRefusal('Nothing was created: give the bootstrap token, or the name of the variable that holds it.', 'Line: /cloudflare create-token --bootstrap-token <token> (hidden as you type) or --bootstrap-env <name>');
        const result = await client.createOperationalToken({
          components: componentsFromArgs(parsed),
          ...optionalString('accountId', getFlag(parsed, 'account') || getFlag(parsed, 'account-id')),
          ...optionalString('zoneId', getFlag(parsed, 'zone-id')),
          ...optionalString('zoneName', getFlag(parsed, 'zone') || getFlag(parsed, 'zone-name')),
          bootstrapToken,
          storeApiToken: true,
          persistConfig: true,
          // --new makes a fresh token even when the daemon holds one for this selection.
          ...(hasFlag(parsed, 'new') ? { reuse: false } : {}),
        });
        return [
          result.reused ? 'Cloudflare Operational Token Reused' : 'Cloudflare Operational Token Created',
          `  token: ${result.tokenName}${result.tokenId ? ` (${result.tokenId})` : ''}`,
          ...(result.reused ? ['  the daemon already holds a live token for this selection; nothing was created (add --new for a fresh one).'] : []),
          ...(result.replaced ? [`  replaced token ${result.replaced.tokenId}: ${result.replaced.revoked ? 'revoked' : `still live (${result.replaced.reason ?? 'could not be revoked'}); delete it in the Cloudflare dashboard`}`] : []),
          `  account: ${result.accountId}`,
          `  zone: ${result.zoneId || '(none)'}`,
          `  stored ref: ${result.apiTokenRef ?? '(not stored)'}`,
          '  revoke or expire the temporary bootstrap token after validation.',
        ].join('\n');
      }

      if (subcommand === 'discover') {
        const result = await client.discover({
          ...cloudflareAuthInput(parsed),
          components: componentsFromArgs(parsed),
          ...optionalString('zoneId', getFlag(parsed, 'zone-id')),
          ...optionalString('zoneName', getFlag(parsed, 'zone') || getFlag(parsed, 'zone-name')),
          includeResources: !hasFlag(parsed, 'fast'),
        });
        return [
          'Cloudflare Discovery',
          `  token source: ${result.tokenSource}`,
          `  accounts: ${result.accounts.length}`,
          ...result.accounts.slice(0, 12).map((account) => `    account ${account.id}: ${account.name}`),
          `  zones: ${result.zones.length}`,
          ...result.zones.slice(0, 12).map((zone) => `    zone ${zone.id}: ${zone.name}${zone.status ? ` (${zone.status})` : ''}`),
          `  worker subdomain: ${result.workerSubdomain || '(not detected)'}`,
          `  queues: ${result.queues?.length ?? 0}`,
          `  KV namespaces: ${result.kvNamespaces?.length ?? 0}`,
          `  R2 buckets: ${result.r2Buckets?.length ?? 0}`,
          ...result.warnings.map((warning) => `  warning: ${warning}`),
        ].join('\n');
      }

      if (subcommand === 'validate') {
        const result = await client.validate(cloudflareAuthInput(parsed));
        return [
          'Cloudflare Token Validation',
          `  ok: ${result.ok ? 'yes' : 'no'}`,
          `  token source: ${result.tokenSource}`,
          result.account ? `  account: ${result.account.name} (${result.account.id})` : '  account: not resolved',
        ].join('\n');
      }

      if (subcommand === 'provision') {
        const result = await client.provision({
          ...cloudflareAuthInput(parsed),
          components: componentsFromArgs(parsed),
          ...optionalString('accountId', getFlag(parsed, 'account') || getFlag(parsed, 'account-id')),
          ...optionalString('zoneId', getFlag(parsed, 'zone-id')),
          ...optionalString('zoneName', getFlag(parsed, 'zone') || getFlag(parsed, 'zone-name')),
          ...optionalString('daemonBaseUrl', getFlag(parsed, 'daemon-url')),
          ...optionalString('daemonHostname', getFlag(parsed, 'daemon-hostname')),
          ...optionalString('workerName', getFlag(parsed, 'worker-name')),
          ...optionalString('workerSubdomain', getFlag(parsed, 'worker-subdomain')),
          ...optionalString('workerHostname', getFlag(parsed, 'worker-hostname')),
          ...optionalString('workerBaseUrl', getFlag(parsed, 'worker-url')),
          ...optionalString('queueName', getFlag(parsed, 'queue') || getFlag(parsed, 'queue-name')),
          ...optionalString('deadLetterQueueName', getFlag(parsed, 'dlq') || getFlag(parsed, 'dead-letter-queue')),
          ...optionalString('tunnelName', getFlag(parsed, 'tunnel-name')),
          ...optionalString('tunnelId', getFlag(parsed, 'tunnel-id')),
          ...optionalString('tunnelServiceUrl', getFlag(parsed, 'tunnel-service-url')),
          ...optionalString('tunnelTokenRef', getFlag(parsed, 'tunnel-token-ref')),
          ...optionalString('accessAppId', getFlag(parsed, 'access-app-id')),
          ...optionalString('accessServiceTokenId', getFlag(parsed, 'access-service-token-id')),
          ...optionalString('accessServiceTokenRef', getFlag(parsed, 'access-service-token-ref')),
          ...optionalString('kvNamespaceName', getFlag(parsed, 'kv-namespace-name')),
          ...optionalString('kvNamespaceId', getFlag(parsed, 'kv-namespace-id')),
          ...optionalString('durableObjectNamespaceName', getFlag(parsed, 'do-namespace-name') || getFlag(parsed, 'durable-object-namespace-name')),
          ...optionalString('r2BucketName', getFlag(parsed, 'r2-bucket-name')),
          ...optionalString('secretsStoreName', getFlag(parsed, 'secrets-store-name')),
          ...optionalString('secretsStoreId', getFlag(parsed, 'secrets-store-id')),
          ...optionalString('workerCron', getFlag(parsed, 'worker-cron')),
          ...optionalString('operatorToken', getFlag(parsed, 'operator-token')),
          ...optionalString('operatorTokenRef', getFlag(parsed, 'operator-token-ref')),
          ...optionalString('workerClientToken', getFlag(parsed, 'worker-client-token')),
          ...optionalString('workerClientTokenRef', getFlag(parsed, 'worker-client-token-ref')),
          ...optionalBatchMode(readBatchMode(parsed)),
          persistConfig: true,
          verify: !hasFlag(parsed, 'no-verify'),
          storeApiToken: !hasFlag(parsed, 'no-store-token'),
          enableWorkersDev: !hasFlag(parsed, 'no-workers-dev'),
        });
        return [
          'Cloudflare Provisioning',
          `  ok: ${!result.ok ? 'no' : result.warnings?.length ? `partial (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'})` : 'yes'}`,
          ...(result.warnings ?? []).map((warning) => `  warning: ${warning}`),
          ...(result.worker ? [`  worker: ${result.worker.name}${result.worker.baseUrl ? ` at ${result.worker.baseUrl}` : ''}`] : []),
          ...(result.queues ? [`  queues: ${result.queues.queueName}; DLQ ${result.queues.deadLetterQueueName}`] : []),
          ...(result.tunnel ? [`  tunnel: ${result.tunnel.name} (${result.tunnel.id})${result.tunnel.hostname ? ` ${result.tunnel.hostname}` : ''}`] : []),
          ...(result.access ? [`  access: app=${result.access.appId || '(none)'} serviceToken=${result.access.serviceTokenId || '(none)'}`] : []),
          ...(result.dns ? [`  dns: ${result.dns.zoneName || result.dns.zoneId} records=${result.dns.records.length}`] : []),
          ...(result.kv ? [`  kv: ${result.kv.namespaceName} (${result.kv.namespaceId})`] : []),
          ...(result.r2 ? [`  r2: ${result.r2.bucketName}`] : []),
          ...(result.secretsStore ? [`  secrets store: ${result.secretsStore.storeName} (${result.secretsStore.storeId})`] : []),
          ...formatProvisionSteps(result.steps),
        ].join('\n');
      }

      if (subcommand === 'verify') {
        const result = await client.verify({
          ...optionalString('workerBaseUrl', getFlag(parsed, 'worker-url')),
          ...optionalString('workerClientToken', getFlag(parsed, 'worker-token')),
          ...optionalString('workerClientTokenRef', getFlag(parsed, 'worker-token-ref')),
        });
        return [
          'Cloudflare Verification',
          `  ok: ${result.ok ? 'yes' : 'no'}`,
          `  worker health: ${result.workerHealth.ok ? 'ok' : 'failed'} (HTTP ${result.workerHealth.status})${result.workerHealth.error ? ` - ${result.workerHealth.error}` : ''}`,
          ...(result.daemonBatchProxy ? [`  daemon batch proxy: ${result.daemonBatchProxy.ok ? 'ok' : 'failed'} (HTTP ${result.daemonBatchProxy.status})${result.daemonBatchProxy.error ? ` - ${result.daemonBatchProxy.error}` : ''}`] : []),
        ].join('\n');
      }

      if (subcommand === 'disable') {
        const result = await client.disable({
          ...cloudflareAuthInput(parsed),
          ...optionalString('workerName', getFlag(parsed, 'worker-name')),
          // A token allowed to edit API tokens also revokes the operational token this daemon made.
          ...optionalString('bootstrapToken', getFlag(parsed, 'bootstrap-token') || readTokenEnv(parsed, 'bootstrap-env')),
          disableWorkerSubdomain: !hasFlag(parsed, 'keep-worker-subdomain'),
          disableCron: !hasFlag(parsed, 'keep-cron'),
          persistConfig: true,
        });
        return [
          'Cloudflare Disabled',
          `  ok: ${result.ok ? 'yes' : 'no'}`,
          `  remote: ${result.remote === 'disabled' ? 'disabled at Cloudflare' : 'not fully disabled at Cloudflare; see the steps below'}`,
          ...formatProvisionSteps(result.steps),
          '  /cloudflare provision sets it up again; nothing was deleted at Cloudflare.',
        ].join('\n');
      }

    throw commandRefusal(`/cloudflare has no step "${subcommand}".`);
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`Cloudflare ${subcommand} failed: ${formatCloudflareError(error)}`, undefined, 'COMMAND_FAILED');
  }
}

/** The values of an action back into the flags its subcommand declares, read and checked by the one parser. */
function lineOf(values: ActionValues, inputs: readonly InputDescription[]): string[] {
  const args: string[] = [];
  for (const input of inputs) {
    const value = values[input.id];
    if (value === undefined || value === '' || !('flag' in input.typed)) continue;
    const flag = input.typed.flag;
    if (input.typed.switchOn !== undefined) { if (value === input.typed.switchOn) args.push(flag); continue; }
    for (const one of value.split('\n')) if (one) args.push(flag, one);
  }
  return args;
}

const COMPONENT_CHOICES: readonly FixedChoice[] = CLOUDFLARE_COMPONENT_IDS.map((id) => ({ value: id, label: CLOUDFLARE_COMPONENT_LABELS[id] }));
const DEFAULT_COMPONENTS = CLOUDFLARE_COMPONENT_IDS.filter((id) => DEFAULT_CLOUDFLARE_COMPONENT_SELECTION[id]).map((id) => CLOUDFLARE_COMPONENT_LABELS[id]).join(' and ');

function text(id: string, flag: `--${string}`, label: string, help: string, step?: number): InputDescription {
  return textInput({ id, label, help, why: 'a value from your Cloudflare account', typed: { flag }, optional: { default: '', means: 'not given' }, ...(step ? { step } : {}) });
}
function secret(id: string, flag: `--${string}`, label: string, help: string, step?: number): InputDescription {
  return { id, label, help: `${help}; hidden as you type`, kind: 'secret', required: { default: '', defaultMeans: 'not given' }, typed: { flag }, ...(step ? { step } : {}) };
}
function toggle(id: string, flag: `--${string}`, label: string, help: string, off: string, on: string, step?: number): InputDescription {
  return choiceInput({ id, label, help, typed: { flag, switchOn: 'yes' }, choices: [{ value: 'no', label: off }, { value: 'yes', label: on }], optional: { default: 'no', means: off.toLowerCase() }, ...(step ? { step } : {}) });
}
const COMPONENTS = (step?: number): InputDescription[] => [
  { id: 'component', label: 'Also use', help: `Parts to add to the usual ${DEFAULT_COMPONENTS}`, kind: 'choice', choices: COMPONENT_CHOICES, required: { default: '', defaultMeans: `the usual ${DEFAULT_COMPONENTS}` }, typed: { flag: '--component', repeats: true }, ...(step ? { step } : {}) },
  { id: 'without', label: 'Leave out', help: 'Usual parts not to use', kind: 'choice', choices: COMPONENT_CHOICES, required: { default: '', defaultMeans: 'none left out' }, typed: { flag: '--no-component', repeats: true }, ...(step ? { step } : {}) },
  toggle('all', '--all', 'Every part', 'Use every part Cloudflare offers here', 'Only the parts chosen', 'Every part', step),
];
const AUTH = (step?: number): InputDescription[] => [
  text('account', '--account', 'Account', 'The Cloudflare account id', step),
  secret('token', '--token', 'API token', 'A token to use instead of the stored one', step),
  text('tokenEnv', '--token-env', 'Token variable', 'The environment variable that holds the token', step),
  text('tokenRef', '--token-ref', 'Token reference', 'A goodvibes://secrets/ reference to the token', step),
];
const ZONE = (step?: number): InputDescription[] => [
  text('zoneId', '--zone-id', 'Zone id', 'The DNS zone, by id', step),
  text('zone', '--zone', 'Zone', 'The DNS zone, by name', step),
];
const BOOTSTRAP = (step?: number): InputDescription[] => [
  secret('bootstrap', '--bootstrap-token', 'Bootstrap token', 'A short-lived token allowed to create API tokens', step),
  text('bootstrapEnv', '--bootstrap-env', 'Bootstrap variable', 'The environment variable that holds the bootstrap token', step),
];
const DAEMON_SIDE = { terminalOnly: 'The web UI sets Cloudflare up on its own Cloudflare screen.' } as const;
const OUTWARD = 'it acts on the owner\'s Cloudflare account';

/** `/cloudflare`, described once (command-actions/) for both terminal apps. */
export function createCloudflareCommand<Context extends CommandActionContext>(policy: CloudflareCommandPolicy<Context>): DescribedCommand<Context> {
  const step = (sub: string, inputs: readonly InputDescription[]) => async (values: ActionValues, ctx: Context): Promise<string> => {
    const line = readCloudflareLine(sub, lineOf(values, inputs));
    if (!line.ok) throw commandRefusal(`Cloudflare ${sub}: ${line.problem} Nothing was sent.`);
    return runCloudflare(sub, line.parsed, ctx, policy);
  };
  const requirementsInputs = COMPONENTS();
  const createInputs = [...BOOTSTRAP(1), ...COMPONENTS(1), text('account', '--account', 'Account', 'The Cloudflare account id', 2), ...ZONE(2),
    toggle('fresh', '--new', 'If one is held', 'When the daemon already holds a token for these parts', 'Use that one', 'Make a fresh one', 2)];
  const discoverInputs = [...AUTH(1), ...COMPONENTS(2), ...ZONE(2), toggle('fast', '--fast', 'How far', 'Whether to list queues, KV and R2 too', 'Accounts, zones and resources', 'Accounts and zones only', 2)];
  const validateInputs = AUTH();
  const provisionInputs = [
    ...COMPONENTS(1), ...AUTH(1), ...ZONE(1),
    text('daemonUrl', '--daemon-url', 'Daemon address', 'Where the worker reaches the daemon', 2),
    text('daemonHostname', '--daemon-hostname', 'Daemon hostname', 'The public hostname for the daemon', 2),
    text('workerName', '--worker-name', 'Worker name', 'What to call the worker', 2),
    text('workerSubdomain', '--worker-subdomain', 'Worker subdomain', 'The workers.dev subdomain', 2),
    text('workerHostname', '--worker-hostname', 'Worker hostname', 'A hostname for the worker on your zone', 2),
    text('workerUrl', '--worker-url', 'Worker address', 'The worker\'s address when you know it', 2),
    text('workerCron', '--worker-cron', 'Worker schedule', 'A cron line for the worker', 2),
    choiceInput({ id: 'batchMode', label: 'Batch mode', help: 'Which work goes through Cloudflare batches', typed: { flag: '--batch-mode' },
      choices: [{ value: 'off', label: 'None' }, { value: 'explicit', label: 'Only when asked' }, { value: 'eligible-by-default', label: 'Whatever can, by default' }],
      optional: { default: '', means: 'as it is now' }, step: 2 }),
    text('queue', '--queue', 'Queue', 'The queue\'s name', 3),
    text('dlq', '--dlq', 'Dead-letter queue', 'The dead-letter queue\'s name', 3),
    text('tunnelName', '--tunnel-name', 'Tunnel name', 'The tunnel\'s name', 3),
    text('tunnelId', '--tunnel-id', 'Tunnel id', 'An existing tunnel, by id', 3),
    text('tunnelServiceUrl', '--tunnel-service-url', 'Tunnel target', 'What the tunnel points at', 3),
    text('tunnelTokenRef', '--tunnel-token-ref', 'Tunnel token reference', 'A goodvibes://secrets/ reference to the tunnel token', 3),
    text('accessAppId', '--access-app-id', 'Access app', 'An existing Access application, by id', 3),
    text('accessServiceTokenId', '--access-service-token-id', 'Access service token', 'An existing Access service token, by id', 3),
    text('accessServiceTokenRef', '--access-service-token-ref', 'Access token reference', 'A goodvibes://secrets/ reference to it', 3),
    text('kvName', '--kv-namespace-name', 'KV namespace', 'The KV namespace\'s name', 3),
    text('kvId', '--kv-namespace-id', 'KV namespace id', 'An existing KV namespace, by id', 3),
    text('doName', '--do-namespace-name', 'Durable Objects namespace', 'The Durable Objects namespace\'s name', 3),
    text('r2Bucket', '--r2-bucket-name', 'R2 bucket', 'The R2 bucket\'s name', 3),
    text('storeName', '--secrets-store-name', 'Secrets Store', 'The Secrets Store\'s name', 3),
    text('storeId', '--secrets-store-id', 'Secrets Store id', 'An existing Secrets Store, by id', 3),
    secret('operatorToken', '--operator-token', 'Operator token', 'The token the worker uses to reach the daemon', 4),
    text('operatorTokenRef', '--operator-token-ref', 'Operator token reference', 'A goodvibes://secrets/ reference to it', 4),
    secret('workerClientToken', '--worker-client-token', 'Worker client token', 'The token the daemon uses to reach the worker', 4),
    text('workerClientTokenRef', '--worker-client-token-ref', 'Worker client token reference', 'A goodvibes://secrets/ reference to it', 4),
    toggle('noVerify', '--no-verify', 'Check it after', 'Whether to check the worker once it is deployed', 'Check it', 'Do not check it', 4),
    toggle('noStore', '--no-store-token', 'Keep the API token', 'Whether the daemon stores the token used', 'Store it', 'Do not store it', 4),
    toggle('noWorkersDev', '--no-workers-dev', 'workers.dev address', 'Whether the worker also answers on workers.dev', 'Turn it on', 'Leave it off', 4),
  ];
  const verifyInputs = [
    text('workerUrl', '--worker-url', 'Worker address', 'The worker to check; blank checks the one set up'),
    secret('workerToken', '--worker-token', 'Worker token', 'A token to check with instead of the stored one'),
    text('workerTokenRef', '--worker-token-ref', 'Worker token reference', 'A goodvibes://secrets/ reference to it'),
  ];
  const disableInputs = [
    ...AUTH(1), text('workerName', '--worker-name', 'Worker name', 'The worker to turn off', 1), ...BOOTSTRAP(2),
    toggle('keepCron', '--keep-cron', 'The worker schedule', 'Whether the worker\'s cron trigger stays', 'Turn it off', 'Keep it', 2),
    toggle('keepSubdomain', '--keep-worker-subdomain', 'The workers.dev address', 'Whether the worker keeps answering on workers.dev', 'Turn it off', 'Keep it', 2),
  ];
  const actions: ActionDescription<Context>[] = [
    readAction<Context>({
      id: 'status', label: 'See whether Cloudflare is set up', word: 'status', operator: DAEMON_SIDE,
      sentence: 'Shows whether the Cloudflare integration is on and ready, which parts are deployed, and the batch settings.',
      run: step('status', []),
    }),
    doAction<Context>({
      id: 'setup', label: 'Set Cloudflare up step by step', word: 'setup', touches: 'reads', operator: DAEMON_SIDE,
      sentence: 'Opens the guided Cloudflare setup, one question at a time.',
      async run(_values, ctx) {
        if (!policy.openSetup?.(ctx)) throw commandRefusal('This program has no guided Cloudflare setup.', 'Use /cloudflare requirements, then create-token and provision.');
        return undefined;
      },
    }),
    readAction<Context>({
      id: 'requirements', label: 'See what the API token needs', word: 'requirements', inputs: requirementsInputs, operator: DAEMON_SIDE,
      sentence: 'Lists the permissions the API token needs for the parts chosen, and how to make the bootstrap token.',
      example: { component: 'kv' }, run: step('requirements', requirementsInputs),
    }),
    {
      id: 'create-token', label: 'Create the API token GoodVibes uses', word: 'create-token', inputs: createInputs,
      sentence: 'A Cloudflare API token for the parts chosen is created on your account and stored by the daemon, until you change it; the bootstrap token is used once and not kept.',
      done: '', touches: 'another-machine', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: `${OUTWARD} and stores a credential`, instead: 'Ask the owner to run /cloudflare create-token.' },
      operator: DAEMON_SIDE, example: { bootstrapEnv: 'CF_BOOTSTRAP', account: 'acc-1' }, run: step('create-token', createInputs),
    },
    readAction<Context>({
      id: 'discover', label: 'Find your Cloudflare accounts and resources', word: 'discover', inputs: discoverInputs, operator: DAEMON_SIDE,
      sentence: 'Asks Cloudflare which accounts, zones, queues, KV namespaces and R2 buckets the token can see.',
      example: { fast: 'yes' }, run: step('discover', discoverInputs),
    }),
    readAction<Context>({
      id: 'validate', label: 'Check a Cloudflare token', word: 'validate', inputs: validateInputs, operator: DAEMON_SIDE,
      sentence: 'Asks Cloudflare whether the token works and which account it belongs to.',
      example: { tokenRef: 'goodvibes://secrets/user/CLOUDFLARE_API_TOKEN' }, run: step('validate', validateInputs),
    }),
    {
      id: 'provision', label: 'Deploy GoodVibes on Cloudflare', word: 'provision', inputs: provisionInputs,
      sentence: 'The parts chosen are created or updated on your Cloudflare account (the worker, its queues and the rest) and the daemon is set to use them, until you change it.',
      done: '', touches: 'another-machine', lasts: 'kept', risk: 'spends-money', undoneBy: 'disable',
      ownerOnly: { reason: `${OUTWARD}, deploys resources it may bill for and stores their credentials`, instead: 'Ask the owner to run /cloudflare provision.' },
      operator: DAEMON_SIDE, example: { component: 'kv', workerName: 'goodvibes' }, run: step('provision', provisionInputs),
    },
    readAction<Context>({
      id: 'verify', label: 'Check the deployed worker', word: 'verify', inputs: verifyInputs, operator: DAEMON_SIDE,
      sentence: 'Calls the worker\'s health check and the daemon\'s batch proxy through it, and says whether each answered.',
      example: { workerUrl: 'https://goodvibes.example.workers.dev' }, run: step('verify', verifyInputs),
    }),
    {
      id: 'disable', label: 'Turn the Cloudflare integration off', word: 'disable', inputs: disableInputs,
      sentence: 'The integration is turned off here and its worker schedule and workers.dev address are turned off at Cloudflare, until you change it; nothing is deleted at Cloudflare.',
      done: '', touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'provision',
      ownerOnly: { reason: `${OUTWARD} and can revoke its token`, instead: 'Ask the owner to run /cloudflare disable.' },
      operator: DAEMON_SIDE, example: { keepCron: 'yes' }, run: step('disable', disableInputs),
    },
  ];
  return defineCommand<Context>({
    name: 'cloudflare',
    title: 'Cloudflare',
    summary: 'Set up, check and turn off the optional Cloudflare integration for batches and remote work',
    group: 'Services',
    report: 'status',
    firstScreenRows: ['status', 'setup', 'requirements', 'create-token', 'provision', { label: 'Check or turn off…', actions: ['discover', 'validate', 'verify', 'disable'] }],
    actions,
  });
}

function hasFlag(args: ParsedCloudflareArgs, key: string): boolean {
  return args.flags.has(key);
}

function getFlag(args: ParsedCloudflareArgs, key: string): string {
  const values = args.flags.get(key);
  return values?.[values.length - 1] ?? '';
}

function getFlagValues(args: ParsedCloudflareArgs, key: string): readonly string[] {
  return args.flags.get(key) ?? [];
}

function componentsFromArgs(args: ParsedCloudflareArgs): Record<CloudflareComponent, boolean> {
  const components: Record<CloudflareComponent, boolean> = { ...DEFAULT_CLOUDFLARE_COMPONENT_SELECTION };
  if (hasFlag(args, 'all') || hasFlag(args, 'advanced')) {
    for (const component of CLOUDFLARE_COMPONENT_IDS) components[component] = true;
  }
  for (const raw of [...args.positional, ...getFlagValues(args, 'component')]) {
    const normalized = normalizeComponent(raw);
    if (normalized) components[normalized] = true;
  }
  for (const raw of getFlagValues(args, 'no-component')) {
    const normalized = normalizeComponent(raw);
    if (normalized) components[normalized] = false;
  }
  return components;
}

function normalizeComponent(value: string): CloudflareComponent | null {
  const normalized = value.trim().toLowerCase().replace(/[-_]/g, '');
  for (const component of CLOUDFLARE_COMPONENT_IDS) {
    if (component.toLowerCase() === normalized) return component;
  }
  if (normalized === 'workerscript' || normalized === 'worker') return 'workers';
  if (normalized === 'queue') return 'queues';
  if (normalized === 'tunnel') return 'zeroTrustTunnel';
  if (normalized === 'access') return 'zeroTrustAccess';
  if (normalized === 'domain' || normalized === 'hostname') return 'dns';
  if (normalized === 'do' || normalized === 'durableobject') return 'durableObjects';
  if (normalized === 'secret' || normalized === 'secrets') return 'secretsStore';
  return null;
}

function formatComponents(components: CloudflareComponentSelection): string {
  const selected = CLOUDFLARE_COMPONENT_IDS
    .filter((component) => components[component] === true)
    .map((component) => CLOUDFLARE_COMPONENT_LABELS[component]);
  return selected.length > 0 ? selected.join(', ') : 'none';
}

function cloudflareAuthInput(args: ParsedCloudflareArgs): {
  readonly accountId?: string;
  readonly apiToken?: string;
  readonly apiTokenRef?: string;
} {
  const token = getFlag(args, 'token') || readTokenEnv(args, 'token-env');
  const tokenRef = getFlag(args, 'token-ref');
  return {
    ...optionalString('accountId', getFlag(args, 'account') || getFlag(args, 'account-id')),
    ...(token ? { apiToken: token } : tokenRef ? { apiTokenRef: tokenRef } : {}),
  };
}

function readTokenEnv(args: ParsedCloudflareArgs, key: string): string {
  const envName = getFlag(args, key);
  if (!envName) return '';
  return process.env[envName] ?? '';
}

function readBatchMode(args: ParsedCloudflareArgs): (typeof BATCH_MODES)[number] | undefined {
  const value = getFlag(args, 'batch-mode');
  return (BATCH_MODES as readonly string[]).includes(value) ? value as (typeof BATCH_MODES)[number] : undefined;
}

function optionalString<K extends string>(key: K, value: string): Partial<Record<K, string>> {
  return value.trim().length > 0 ? { [key]: value.trim() } as Partial<Record<K, string>> : {};
}

function optionalBatchMode(value: ReturnType<typeof readBatchMode>): { readonly batchMode?: 'off' | 'explicit' | 'eligible-by-default' } {
  return value ? { batchMode: value } : {};
}

function formatProvisionSteps(steps: readonly CloudflareProvisionStep[]): string[] {
  return steps.length > 0
    ? steps.map((step) => `  ${step.status}: ${step.name}${step.message ? ` - ${step.message}` : ''}`)
    : ['  no steps returned'];
}

function formatCloudflareError(error: unknown): string {
  if (error instanceof CloudflareDaemonRouteError) {
    return `${error.message} (HTTP ${error.status}, ${error.code})`;
  }
  return summarizeError(error);
}
