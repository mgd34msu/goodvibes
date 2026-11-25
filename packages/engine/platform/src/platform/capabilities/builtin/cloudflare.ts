/**
 * The optional Cloudflare integration (batches and remote work through a
 * worker on your own Cloudflare account): its settings and tokens are the
 * daemon's, and the daemon's `cloudflare.*` methods do every act through the
 * one manager that serializes them. Each definition builds its method's body
 * from the inputs (the parts chosen, the token given or the stored one) and
 * words the answer; nothing here talks to Cloudflare itself. A token typed in
 * is a secret input: it travels only in the method's body.
 */
import { CapabilityRefusal, type ActionValues, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription } from '../types.js';

type Definition = CapabilityDefinition<unknown>;

const COMPONENTS = [
  ['workers', 'Workers'], ['queues', 'Queues'], ['zeroTrustTunnel', 'Zero Trust Tunnel'], ['zeroTrustAccess', 'Zero Trust Access'],
  ['dns', 'DNS hostname'], ['kv', 'KV'], ['durableObjects', 'Durable Objects'], ['secretsStore', 'Secrets Store'], ['r2', 'R2 artifacts'],
] as const;
const COMPONENT_CHOICES: readonly FixedChoice[] = COMPONENTS.map(([value, label]) => ({ value, label }));
const USUAL = 'the usual Workers and Queues';

interface Step { readonly name?: unknown; readonly status?: unknown; readonly message?: unknown }

const str = (value: unknown): string => typeof value === 'string' ? value : '';
const steps = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value as Step[] : [];
  return list.length > 0 ? list.map((step) => `  ${str(step.status)}: ${str(step.name)}${str(step.message) ? ` - ${str(step.message)}` : ''}`) : ['  no steps returned'];
};

/** The daemon method, as the same caller. */
async function call(caller: CapabilityCaller, methodId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!caller.method) throw new CapabilityRefusal('Cloudflare is set up through the daemon\'s own methods, which this run cannot reach.', 'Run it from the Devices and network place, the web UI or goodvibes do.');
  let answer: unknown;
  try {
    answer = await caller.method(methodId, body);
  } catch (error) {
    // The daemon names its environment variable and field for a script; a person gives the token in this form.
    if (/API token is required/.test(error instanceof Error ? error.message : String(error))) {
      throw new CapabilityRefusal('Nothing was asked of Cloudflare: no API token is stored and none was given. Give one under API token (typed hidden), or create it first with Create the token.', 'See what the API token needs says which permissions it takes.');
    }
    if (/account id is required/.test(error instanceof Error ? error.message : String(error))) {
      throw new CapabilityRefusal('Nothing was asked of Cloudflare: no account is set and none was given. Give it under Account; Find accounts lists the ones your token sees.', 'Find your Cloudflare accounts and resources lists them.');
    }
    throw error;
  }
  return answer !== null && typeof answer === 'object' && !Array.isArray(answer) ? answer as Record<string, unknown> : {};
}

function optional(id: string, label: string, help: string, step?: number): InputDescription {
  return { id, label, help, kind: 'text', freeTextReason: 'a value from your Cloudflare account', required: { default: '', defaultMeans: 'not given' }, typed: { flag: `--${id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}` }, ...(step ? { step } : {}) };
}
function secret(id: string, label: string, help: string, step?: number): InputDescription {
  return { id, label, help: `${help}; hidden as you type`, kind: 'secret', required: { default: '', defaultMeans: 'not given' }, typed: { flag: `--${id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}` }, ...(step ? { step } : {}) };
}
function toggle(id: string, label: string, help: string, off: string, on: string, step?: number): InputDescription {
  return { id, label, help, kind: 'choice', choices: [{ value: 'no', label: off }, { value: 'yes', label: on }], required: { default: 'no', defaultMeans: off.toLowerCase() }, typed: { flag: `--${id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, switchOn: 'yes' }, ...(step ? { step } : {}) };
}
const PARTS = (step?: number): InputDescription[] => [
  { id: 'component', label: 'Also use', help: `Parts to add to ${USUAL}`, kind: 'choice', choices: COMPONENT_CHOICES, required: { default: '', defaultMeans: USUAL }, typed: { flag: '--component', repeats: true }, ...(step ? { step } : {}) },
  { id: 'without', label: 'Leave out', help: 'Usual parts not to use', kind: 'choice', choices: COMPONENT_CHOICES, required: { default: '', defaultMeans: 'none left out' }, typed: { flag: '--no-component', repeats: true }, ...(step ? { step } : {}) },
  toggle('all', 'Every part', 'Use every part Cloudflare offers here', 'Only the parts chosen', 'Every part', step),
];
const TOKEN = (step?: number): InputDescription[] => [
  optional('account', 'Account', 'The Cloudflare account id', step),
  secret('token', 'API token', 'A token to use instead of the one the daemon stores', step),
  optional('tokenRef', 'Token reference', 'A goodvibes://secrets/ reference to the token', step),
];
const ZONE = (step?: number): InputDescription[] => [optional('zoneId', 'Zone id', 'The DNS zone, by id', step), optional('zone', 'Zone', 'The DNS zone, by name', step)];

/** The parts chosen, as the daemon reads them: a part not named keeps its usual setting. */
function componentsOf(values: ActionValues): Record<string, boolean> {
  const lines = (id: string): string[] => (values[id] ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const chosen: Record<string, boolean> = {};
  if (values.all === 'yes') for (const [id] of COMPONENTS) chosen[id] = true;
  for (const id of lines('component')) chosen[id] = true;
  for (const id of lines('without')) chosen[id] = false;
  return chosen;
}
const given = (key: string, value: string | undefined): Record<string, string> => value && value.trim() ? { [key]: value.trim() } : {};
function credentials(values: ActionValues): Record<string, string> {
  return { ...given('accountId', values.account), ...(values.token ? { apiToken: values.token } : given('apiTokenRef', values.tokenRef)) };
}
const zoneOf = (values: ActionValues): Record<string, string> => ({ ...given('zoneId', values.zoneId), ...given('zoneName', values.zone) });
const OUTWARD = 'it acts on the owner\'s Cloudflare account';
const DEVICES_PLACE = 'The Cloudflare tab of Devices and network shows whether Cloudflare is set up.';

function cloudflare(fields: Omit<Definition, 'capability' | 'done' | 'example'> & { readonly id: string; readonly repeat: 'safe' | 'unsafe'; readonly example?: ActionValues }): Definition {
  const { id, repeat, example, ...rest } = fields;
  return { ...rest, capability: { id, group: 'devices', home: 'daemon', repeat }, done: '', example: example ?? {} };
}

export const CLOUDFLARE_STATUS = cloudflare({
  id: 'cloudflare.status', repeat: 'safe', actionId: 'status', label: 'See whether Cloudflare is set up', word: 'status', inputs: [],
  sentence: 'Shows whether the Cloudflare integration is on and ready, which parts are deployed, and the batch settings.',
  touches: 'reads', lasts: 'not-a-change', risk: 'none',
  async run(_values, _services, caller) {
    const status = await call(caller, 'cloudflare.status', {});
    const config = (status.config ?? {}) as Record<string, unknown>;
    const configured = (status.configured ?? {}) as Record<string, unknown>;
    const made = (key: string, value: unknown): string => configured[key] && str(value) ? str(value) : 'not deployed';
    const warnings = Array.isArray(status.warnings) ? (status.warnings as unknown[]).map(str).filter(Boolean) : [];
    return {
      text: [
        `Cloudflare is ${status.enabled ? 'on' : 'off'} and ${status.ready ? 'ready' : 'not ready'}.`,
        `  Account: ${str(config.accountId) || 'not set'}`,
        `  Worker: ${made('workerName', config.workerName)}${str(config.workerBaseUrl) ? ` at ${str(config.workerBaseUrl)}` : ''}`,
        `  Queue: ${made('queueName', config.queueName)}`,
        `  Tunnel: ${made('tunnel', config.tunnelName)}`,
        `  KV: ${made('kv', config.kvNamespaceName)}; R2: ${made('r2', config.r2BucketName)}`,
        ...warnings.map((warning) => `  Warning: ${warning}`),
      ].join('\n'),
      data: { enabled: status.enabled === true, ready: status.ready === true, configured, warnings },
    };
  },
});

export const CLOUDFLARE_REQUIREMENTS = cloudflare({
  id: 'cloudflare.requirements', repeat: 'safe', actionId: 'requirements', label: 'See what the API token needs', word: 'requirements', inputs: PARTS(),
  sentence: 'Lists the permissions the Cloudflare API token needs for the parts chosen, and how to make the bootstrap token.',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { component: 'kv' },
  async run(values, _services, caller) {
    const result = await call(caller, 'cloudflare.token.requirements.get', { components: componentsOf(values), includeBootstrap: true });
    const permissions = Array.isArray(result.permissions) ? result.permissions as Record<string, unknown>[] : [];
    const bootstrap = ((result.bootstrapToken ?? {}) as { instructions?: unknown }).instructions;
    return {
      text: [
        'The API token needs:',
        ...permissions.map((permission) => `  ${str(permission.scope)}: ${str(permission.permission)} (${str(permission.component)}) - ${str(permission.reason)}`),
        // The daemon's instructions name its HTTP route for a script; a person gives the token to Create the token.
        ...(Array.isArray(bootstrap) && bootstrap.length > 0 ? ['To make the bootstrap token:', ...bootstrap.map((line) => /\/api\/cloudflare\/token\/create/.test(str(line))
          ? '  Then give it to Create the token (Bootstrap token, typed hidden) on the Cloudflare tab of Devices and network.'
          : `  ${str(line)}`)] : []),
      ].join('\n'),
      data: { permissions },
    };
  },
});

export const CLOUDFLARE_CREATE_TOKEN = cloudflare({
  id: 'cloudflare.create-token', repeat: 'safe', actionId: 'create-token', label: 'Create the API token GoodVibes uses', word: 'create-token',
  inputs: [
    secret('bootstrap', 'Bootstrap token', 'A short-lived token allowed to create API tokens', 1), ...PARTS(1),
    optional('account', 'Account', 'The Cloudflare account id', 2), ...ZONE(2),
    toggle('fresh', 'If one is held', 'When the daemon already holds a token for these parts', 'Use that one', 'Make a fresh one', 2),
  ],
  sentence: 'A Cloudflare API token for the parts chosen is created on your account and stored by the daemon, until you change it; the bootstrap token is used once and not kept.',
  touches: 'another-machine', lasts: 'kept', risk: 'none',
  ownerOnly: { reason: `${OUTWARD} and stores a credential`, instead: DEVICES_PLACE },
  example: { account: 'acc-1' },
  async run(values, _services, caller) {
    if (!values.bootstrap) throw new CapabilityRefusal('Nothing was created: give the bootstrap token (a short-lived token allowed to create API tokens).', 'See what the API token needs says how to make one.');
    const result = await call(caller, 'cloudflare.token.create', {
      components: componentsOf(values), ...given('accountId', values.account), ...zoneOf(values), bootstrapToken: values.bootstrap,
      storeApiToken: true, persistConfig: true, ...(values.fresh === 'yes' ? { reuse: false } : {}),
    });
    const replaced = result.replaced as { tokenId?: unknown; revoked?: unknown; reason?: unknown } | undefined;
    return {
      text: [
        result.reused ? `The daemon already holds a live token for these parts (${str(result.tokenName)}); nothing was created. Choose "Make a fresh one" for a new one.` : `Created the token${str(result.tokenName) ? ` ${str(result.tokenName)}` : ''} and stored it in the daemon.`,
        ...(replaced ? [`The token it replaced (${str(replaced.tokenId)}) was ${replaced.revoked ? 'revoked' : `left live (${str(replaced.reason) || 'it could not be revoked'}); delete it in the Cloudflare dashboard`}.`] : []),
        `Account: ${str(result.accountId)}; zone: ${str(result.zoneId) || 'none'}.`,
        'Revoke or let the bootstrap token expire now that it was used.',
      ].join('\n'),
      data: { tokenName: str(result.tokenName), reused: result.reused === true, accountId: str(result.accountId) },
    };
  },
});

export const CLOUDFLARE_DISCOVER = cloudflare({
  id: 'cloudflare.discover', repeat: 'safe', actionId: 'discover', label: 'Find your Cloudflare accounts and resources', word: 'discover',
  inputs: [...TOKEN(1), ...PARTS(2), ...ZONE(2), toggle('fast', 'How far', 'Whether to list queues, KV and R2 too', 'Accounts, zones and resources', 'Accounts and zones only', 2)],
  sentence: 'Asks Cloudflare which accounts, zones, queues, KV namespaces and R2 buckets the token can see.',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { fast: 'yes' },
  async run(values, _services, caller) {
    const result = await call(caller, 'cloudflare.resources.list', { ...credentials(values), components: componentsOf(values), ...zoneOf(values), includeResources: values.fast !== 'yes' });
    const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value as Record<string, unknown>[] : [];
    const accounts = list(result.accounts);
    const zones = list(result.zones);
    return {
      text: [
        `The token${str(result.tokenSource) ? ` (${str(result.tokenSource)})` : ''} sees ${accounts.length} account${accounts.length === 1 ? '' : 's'} and ${zones.length} zone${zones.length === 1 ? '' : 's'}.`,
        ...accounts.slice(0, 12).map((account) => `  Account ${str(account.name)} (${str(account.id)})`),
        ...zones.slice(0, 12).map((zone) => `  Zone ${str(zone.name)} (${str(zone.id)})`),
        `  Worker subdomain: ${str(result.workerSubdomain) || 'not found'}`,
        `  Queues ${list(result.queues).length}, KV namespaces ${list(result.kvNamespaces).length}, R2 buckets ${list(result.r2Buckets).length}`,
      ].join('\n'),
      data: { accounts, zones, workerSubdomain: str(result.workerSubdomain) },
    };
  },
});

export const CLOUDFLARE_VALIDATE = cloudflare({
  id: 'cloudflare.validate', repeat: 'safe', actionId: 'validate', label: 'Check a Cloudflare token', word: 'validate', inputs: TOKEN(),
  sentence: 'Asks Cloudflare whether the token works and which account it belongs to.',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { tokenRef: 'goodvibes://secrets/user/CLOUDFLARE_API_TOKEN' },
  async run(values, _services, caller) {
    const result = await call(caller, 'cloudflare.credentials.verify', credentials(values));
    const account = result.account as { id?: unknown; name?: unknown } | undefined;
    return {
      text: `The token${str(result.tokenSource) ? ` (${str(result.tokenSource)})` : ''} ${result.ok ? 'works' : 'does not work'}${account ? `; it belongs to ${str(account.name)} (${str(account.id)})` : ''}.`,
      data: { ok: result.ok === true, tokenSource: str(result.tokenSource) },
    };
  },
});

const PROVISION_TEXT: readonly (readonly [string, string, string, string, number])[] = [
  ['daemonUrl', 'daemonBaseUrl', 'Daemon address', 'Where the worker reaches the daemon', 2],
  ['daemonHostname', 'daemonHostname', 'Daemon hostname', 'The public hostname for the daemon', 2],
  ['workerName', 'workerName', 'Worker name', 'What to call the worker', 2],
  ['workerSubdomain', 'workerSubdomain', 'Worker subdomain', 'The workers.dev subdomain', 2],
  ['workerHostname', 'workerHostname', 'Worker hostname', 'A hostname for the worker on your zone', 2],
  ['workerUrl', 'workerBaseUrl', 'Worker address', 'The worker\'s address when you know it', 2],
  ['workerCron', 'workerCron', 'Worker schedule', 'A cron line for the worker', 2],
  ['queue', 'queueName', 'Queue', 'The queue\'s name', 3],
  ['dlq', 'deadLetterQueueName', 'Dead-letter queue', 'The dead-letter queue\'s name', 3],
  ['tunnelName', 'tunnelName', 'Tunnel name', 'The tunnel\'s name', 3],
  ['tunnelId', 'tunnelId', 'Tunnel id', 'An existing tunnel, by id', 3],
  ['tunnelServiceUrl', 'tunnelServiceUrl', 'Tunnel target', 'What the tunnel points at', 3],
  ['tunnelTokenRef', 'tunnelTokenRef', 'Tunnel token reference', 'A goodvibes://secrets/ reference to the tunnel token', 3],
  ['accessAppId', 'accessAppId', 'Access app', 'An existing Access application, by id', 3],
  ['accessServiceTokenId', 'accessServiceTokenId', 'Access service token', 'An existing Access service token, by id', 3],
  ['accessServiceTokenRef', 'accessServiceTokenRef', 'Access token reference', 'A goodvibes://secrets/ reference to it', 3],
  ['kvName', 'kvNamespaceName', 'KV namespace', 'The KV namespace\'s name', 3],
  ['kvId', 'kvNamespaceId', 'KV namespace id', 'An existing KV namespace, by id', 3],
  ['doName', 'durableObjectNamespaceName', 'Durable Objects namespace', 'The Durable Objects namespace\'s name', 3],
  ['r2Bucket', 'r2BucketName', 'R2 bucket', 'The R2 bucket\'s name', 3],
  ['storeName', 'secretsStoreName', 'Secrets Store', 'The Secrets Store\'s name', 3],
  ['storeId', 'secretsStoreId', 'Secrets Store id', 'An existing Secrets Store, by id', 3],
  ['operatorTokenRef', 'operatorTokenRef', 'Operator token reference', 'A goodvibes://secrets/ reference to the token the worker uses to reach the daemon', 4],
  ['workerClientTokenRef', 'workerClientTokenRef', 'Worker client token reference', 'A goodvibes://secrets/ reference to the token the daemon uses to reach the worker', 4],
];

export const CLOUDFLARE_PROVISION = cloudflare({
  id: 'cloudflare.provision', repeat: 'safe', actionId: 'provision', label: 'Deploy GoodVibes on Cloudflare', word: 'provision',
  inputs: [
    ...PARTS(1), ...TOKEN(1), ...ZONE(1),
    ...PROVISION_TEXT.map(([id, , label, help, step]) => optional(id, label, help, step)),
    { id: 'batchMode', label: 'Batch mode', help: 'Which work goes through Cloudflare batches', kind: 'choice',
      choices: [{ value: 'off', label: 'None' }, { value: 'explicit', label: 'Only when asked' }, { value: 'eligible-by-default', label: 'Whatever can, by default' }],
      required: { default: '', defaultMeans: 'as it is now' }, typed: { flag: '--batch-mode' }, step: 2 },
    secret('operatorToken', 'Operator token', 'The token the worker uses to reach the daemon', 4),
    secret('workerClientToken', 'Worker client token', 'The token the daemon uses to reach the worker', 4),
    toggle('noVerify', 'Check it after', 'Whether to check the worker once it is deployed', 'Check it', 'Do not check it', 4),
    toggle('noStore', 'Keep the API token', 'Whether the daemon stores the token used', 'Store it', 'Do not store it', 4),
    toggle('noWorkersDev', 'workers.dev address', 'Whether the worker also answers on workers.dev', 'Turn it on', 'Leave it off', 4),
  ],
  sentence: 'The parts chosen are created or updated on your Cloudflare account (the worker, its queues and the rest) and the daemon is set to use them, until you change it.',
  touches: 'another-machine', lasts: 'kept', risk: 'spends-money', undoneBy: 'disable',
  // Deploying is not a charge: Cloudflare bills what the parts use, under the account's plan.
  riskDone: 'Nothing was paid by this step itself: Cloudflare bills what these parts use, under your account\'s plan, until you take them down.',
  ownerOnly: { reason: `${OUTWARD}, deploys resources it may bill for and stores their credentials`, instead: DEVICES_PLACE },
  example: { component: 'kv', workerName: 'goodvibes' },
  async run(values, _services, caller) {
    const fields = Object.fromEntries(PROVISION_TEXT.flatMap(([id, key]) => values[id]?.trim() ? [[key, values[id]!.trim()]] : []));
    const result = await call(caller, 'cloudflare.provision', {
      ...credentials(values), components: componentsOf(values), ...zoneOf(values), ...fields,
      ...(values.batchMode ? { batchMode: values.batchMode } : {}),
      ...(values.operatorToken ? { operatorToken: values.operatorToken } : {}),
      ...(values.workerClientToken ? { workerClientToken: values.workerClientToken } : {}),
      persistConfig: true, verify: values.noVerify !== 'yes', storeApiToken: values.noStore !== 'yes', enableWorkersDev: values.noWorkersDev !== 'yes',
    });
    const warnings = Array.isArray(result.warnings) ? (result.warnings as unknown[]).map(str).filter(Boolean) : [];
    const worker = result.worker as { name?: unknown; baseUrl?: unknown } | undefined;
    return {
      text: [
        !result.ok ? 'Cloudflare was not fully deployed.' : warnings.length > 0 ? `Deployed on Cloudflare with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.` : 'Deployed on Cloudflare.',
        ...warnings.map((warning) => `  Warning: ${warning}`),
        ...(worker ? [`  Worker: ${str(worker.name)}${str(worker.baseUrl) ? ` at ${str(worker.baseUrl)}` : ''}`] : []),
        ...steps(result.steps),
      ].join('\n'),
      data: { ok: result.ok === true, warnings, ...(worker ? { worker: { name: str(worker.name), baseUrl: str(worker.baseUrl) } } : {}) },
    };
  },
});

export const CLOUDFLARE_VERIFY = cloudflare({
  id: 'cloudflare.verify', repeat: 'safe', actionId: 'verify', label: 'Check the deployed worker', word: 'verify',
  inputs: [
    optional('workerUrl', 'Worker address', 'The worker to check; blank checks the one set up'),
    secret('workerToken', 'Worker token', 'A token to check with instead of the stored one'),
    optional('workerTokenRef', 'Worker token reference', 'A goodvibes://secrets/ reference to it'),
  ],
  sentence: 'Calls the deployed worker\'s health check and the daemon\'s batch proxy through it, and says whether each answered.',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { workerUrl: 'https://goodvibes.example.workers.dev' },
  async run(values, _services, caller) {
    const result = await call(caller, 'cloudflare.worker.verify', {
      ...given('workerBaseUrl', values.workerUrl), ...(values.workerToken ? { workerClientToken: values.workerToken } : given('workerClientTokenRef', values.workerTokenRef)),
    });
    const health = (result.workerHealth ?? {}) as { ok?: unknown; status?: unknown; error?: unknown };
    const proxy = result.daemonBatchProxy as { ok?: unknown; status?: unknown; error?: unknown } | undefined;
    return {
      text: [
        `The worker's health check ${health.ok ? 'answered' : 'failed'} (HTTP ${String(health.status ?? '?')})${str(health.error) ? `: ${str(health.error)}` : ''}.`,
        ...(proxy ? [`The daemon's batch proxy through it ${proxy.ok ? 'answered' : 'failed'} (HTTP ${String(proxy.status ?? '?')})${str(proxy.error) ? `: ${str(proxy.error)}` : ''}.`] : []),
      ].join('\n'),
      data: { ok: result.ok === true },
    };
  },
});

export const CLOUDFLARE_DISABLE = cloudflare({
  id: 'cloudflare.disable', repeat: 'safe', actionId: 'disable', label: 'Turn the Cloudflare integration off', word: 'disable',
  inputs: [
    ...TOKEN(1), optional('workerName', 'Worker name', 'The worker to turn off', 1),
    secret('bootstrap', 'Bootstrap token', 'A short-lived token allowed to edit API tokens; given, it revokes the operational token this daemon made', 2),
    toggle('keepCron', 'The worker schedule', 'Whether the worker\'s cron trigger stays', 'Turn it off', 'Keep it', 2),
    toggle('keepSubdomain', 'The workers.dev address', 'Whether the worker keeps answering on workers.dev', 'Turn it off', 'Keep it', 2),
  ],
  sentence: 'The integration is turned off here, its worker schedule and workers.dev address are turned off at Cloudflare and the worker\'s daemon credential is removed, until you change it; with a bootstrap token the operational token this daemon made is revoked, which cannot be undone.',
  touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', undoneBy: 'provision',
  ownerOnly: { reason: `${OUTWARD} and can revoke its token`, instead: DEVICES_PLACE },
  example: { keepCron: 'yes' },
  async run(values, _services, caller) {
    const result = await call(caller, 'cloudflare.disable', {
      ...credentials(values), ...given('workerName', values.workerName), ...(values.bootstrap ? { bootstrapToken: values.bootstrap } : {}),
      disableWorkerSubdomain: values.keepSubdomain !== 'yes', disableCron: values.keepCron !== 'yes', persistConfig: true,
    });
    const revoked = Array.isArray(result.steps) && (result.steps as Step[]).some((step) => step.name === 'revoke-operational-token' && step.status === 'ok');
    return {
      text: [
        result.remote === 'disabled' ? 'Cloudflare is off, here and at Cloudflare.' : 'Cloudflare is off here; at Cloudflare it is not fully off (see the steps).',
        ...steps(result.steps),
        revoked ? 'The operational token was revoked: create the API token again before deploying again.' : 'Deploying again sets it up again.',
      ].join('\n'),
      data: { ok: result.ok === true, remote: str(result.remote), tokenRevoked: revoked },
    };
  },
});

/** Every Cloudflare capability, in the order a person meets them. */
export const CLOUDFLARE_CAPABILITIES: readonly Definition[] = [
  CLOUDFLARE_STATUS, CLOUDFLARE_REQUIREMENTS, CLOUDFLARE_CREATE_TOKEN, CLOUDFLARE_DISCOVER, CLOUDFLARE_VALIDATE,
  CLOUDFLARE_PROVISION, CLOUDFLARE_VERIFY, CLOUDFLARE_DISABLE,
];
