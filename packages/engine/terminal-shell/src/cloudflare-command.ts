/**
 * /cloudflare in a terminal: inspect and manage the optional Cloudflare
 * batch/control-plane integration through the daemon's Cloudflare routes.
 * Shared by both terminal apps; each supplies the route client for the daemon
 * it talks to, where its settings are read, and its setup screen if it has one.
 * Every flag of every subcommand is declared once, so a misspelt flag or a
 * value flag with no value is refused before anything is sent.
 */
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import type { CommandSubcommandHints } from './command-args-hint.js';
import type { TerminalSlashCommand } from './command-registry.js';
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
const CLOUDFLARE_USAGE = 'Usage: /cloudflare [status|setup|requirements|create-token|discover|validate|provision|verify|disable] [flags]';

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

/** The usage line /cloudflare prints for an unknown subcommand. */
export { CLOUDFLARE_USAGE };

/** What a terminal app supplies to /cloudflare. */
export interface CloudflareCommandPolicy<Context> {
  /** The daemon's Cloudflare routes as this app reaches them; throws when this app cannot say where the daemon is. */
  readonly client: (context: Context) => CloudflareDaemonClient;
  /** A setting as this app reads it, for the status lines. */
  readonly readSetting: (context: Context, key: 'batch.mode' | 'batch.queueBackend') => unknown;
  /** Opens this app's guided Cloudflare setup; returns false when the app has none. */
  readonly openSetup?: ((context: Context) => boolean) | undefined;
}

export const CLOUDFLARE_SUBCOMMAND_HINTS: Readonly<Record<string, string>> = {
  status: '', setup: '', requirements: '[component...] [--all]', 'create-token': '--bootstrap-token <token> | --bootstrap-env <name> [--account <id>] [--new]',
  discover: '[--token-ref <ref>] [--fast]', validate: '[--token <token> | --token-env <name> | --token-ref <ref>]',
  provision: '[component...] [--account <id>] [--no-verify]', verify: '[--worker-url <url>]', disable: '[--keep-cron] [--keep-worker-subdomain] [--bootstrap-token <token> | --bootstrap-env <name>]',
};

/** The /cloudflare command for a terminal app. */
export function createCloudflareCommand<Context extends { print(text: string): void }>(
  policy: CloudflareCommandPolicy<Context>,
): TerminalSlashCommand<Context> & CommandSubcommandHints {
  return {
    name: 'cloudflare',
    aliases: ['cf'],
    description: 'Inspect and manage optional Cloudflare batch/control-plane integration through daemon routes',
    usage: '[status|setup|requirements|create-token|discover|validate|provision|verify|disable] [flags]',
    argsHint: '[status|setup|requirements|create-token|discover|validate|provision|verify|disable]',
    subcommands: CLOUDFLARE_SUBCOMMAND_HINTS,
    // Tokens typed on the line are kept out of the input history.
    secretArgs: { flags: ['--token', '--bootstrap-token', '--operator-token', '--worker-client-token', '--worker-token'] },
    effect: 'mixed',
    readVerbs: ['status', 'show', 'requirements'],
    async handler(args, ctx) {
      const subcommand = (args[0] ?? 'status').toLowerCase();
      if (subcommand === 'setup' || subcommand === 'onboarding') {
        if (policy.openSetup?.(ctx)) {
          ctx.print('Opening /setup → Use Cloudflare.');
        } else {
          ctx.print('This app has no guided Cloudflare setup. Run /cloudflare requirements, then /cloudflare create-token and /cloudflare provision.');
        }
        return;
      }

      const line = readCloudflareLine(subcommand, args.slice(1));
      if (!line.ok) {
        ctx.print(line.problem === CLOUDFLARE_USAGE ? CLOUDFLARE_USAGE : `Cloudflare ${subcommand}: ${line.problem} Nothing was sent.`);
        return;
      }
      const parsed = line.parsed;

      let client: CloudflareDaemonClient;
      try {
        client = policy.client(ctx);
      } catch (error) {
        ctx.print(`Cloudflare command unavailable: ${formatCloudflareError(error)}`);
        return;
      }

      try {
        if (subcommand === 'status' || subcommand === 'show') {
          const status = await client.status();
          // A resource name has a default; it is shown only once a provision created or confirmed it.
          const provisioned = (key: string, value: unknown): string => status.configured[key] && value ? String(value) : '(not provisioned)';
          const connector = status.tunnelConnector;
          ctx.print([
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
          ].join('\n'));
          return;
        }

        if (subcommand === 'requirements') {
          const result = await client.tokenRequirements({
            components: componentsFromArgs(parsed),
            includeBootstrap: true,
          });
          ctx.print([
            'Cloudflare Token Requirements',
            `  components: ${formatComponents(result.components)}`,
            '  permissions:',
            ...result.permissions.map((permission) => `    ${permission.scope}: ${permission.permission} (${permission.component}) - ${permission.reason}`),
            ...(result.bootstrapToken.instructions.length > 0
              ? ['  bootstrap token:', ...result.bootstrapToken.instructions.map((line) => `    ${line}`)]
              : []),
          ].join('\n'));
          return;
        }

        if (subcommand === 'create-token') {
          const bootstrapToken = getFlag(parsed, 'bootstrap-token') || readTokenEnv(parsed, 'bootstrap-env');
          if (!bootstrapToken) {
            ctx.print('Usage: /cloudflare create-token --account <account-id> --bootstrap-token <token> or --bootstrap-env <env-name>');
            return;
          }
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
          ctx.print([
            result.reused ? 'Cloudflare Operational Token Reused' : 'Cloudflare Operational Token Created',
            `  token: ${result.tokenName}${result.tokenId ? ` (${result.tokenId})` : ''}`,
            ...(result.reused ? ['  the daemon already holds a live token for this selection; nothing was created (add --new for a fresh one).'] : []),
            ...(result.replaced ? [`  replaced token ${result.replaced.tokenId}: ${result.replaced.revoked ? 'revoked' : `still live (${result.replaced.reason ?? 'could not be revoked'}); delete it in the Cloudflare dashboard`}`] : []),
            `  account: ${result.accountId}`,
            `  zone: ${result.zoneId || '(none)'}`,
            `  stored ref: ${result.apiTokenRef ?? '(not stored)'}`,
            '  revoke or expire the temporary bootstrap token after validation.',
          ].join('\n'));
          return;
        }

        if (subcommand === 'discover') {
          const result = await client.discover({
            ...cloudflareAuthInput(parsed),
            components: componentsFromArgs(parsed),
            ...optionalString('zoneId', getFlag(parsed, 'zone-id')),
            ...optionalString('zoneName', getFlag(parsed, 'zone') || getFlag(parsed, 'zone-name')),
            includeResources: !hasFlag(parsed, 'fast'),
          });
          ctx.print([
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
          ].join('\n'));
          return;
        }

        if (subcommand === 'validate') {
          const result = await client.validate(cloudflareAuthInput(parsed));
          ctx.print([
            'Cloudflare Token Validation',
            `  ok: ${result.ok ? 'yes' : 'no'}`,
            `  token source: ${result.tokenSource}`,
            result.account ? `  account: ${result.account.name} (${result.account.id})` : '  account: not resolved',
          ].join('\n'));
          return;
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
          ctx.print([
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
          ].join('\n'));
          return;
        }

        if (subcommand === 'verify') {
          const result = await client.verify({
            ...optionalString('workerBaseUrl', getFlag(parsed, 'worker-url')),
            ...optionalString('workerClientToken', getFlag(parsed, 'worker-token')),
            ...optionalString('workerClientTokenRef', getFlag(parsed, 'worker-token-ref')),
          });
          ctx.print([
            'Cloudflare Verification',
            `  ok: ${result.ok ? 'yes' : 'no'}`,
            `  worker health: ${result.workerHealth.ok ? 'ok' : 'failed'} (HTTP ${result.workerHealth.status})${result.workerHealth.error ? ` - ${result.workerHealth.error}` : ''}`,
            ...(result.daemonBatchProxy ? [`  daemon batch proxy: ${result.daemonBatchProxy.ok ? 'ok' : 'failed'} (HTTP ${result.daemonBatchProxy.status})${result.daemonBatchProxy.error ? ` - ${result.daemonBatchProxy.error}` : ''}`] : []),
          ].join('\n'));
          return;
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
          ctx.print([
            'Cloudflare Disabled',
            `  ok: ${result.ok ? 'yes' : 'no'}`,
            `  remote: ${result.remote === 'disabled' ? 'disabled at Cloudflare' : 'not fully disabled at Cloudflare; see the steps below'}`,
            ...formatProvisionSteps(result.steps),
            '  /cloudflare provision sets it up again; nothing was deleted at Cloudflare.',
          ].join('\n'));
          return;
        }

        ctx.print(CLOUDFLARE_USAGE);
      } catch (error) {
        ctx.print(`Cloudflare ${subcommand} failed: ${formatCloudflareError(error)}`);
      }
    },
  };
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
