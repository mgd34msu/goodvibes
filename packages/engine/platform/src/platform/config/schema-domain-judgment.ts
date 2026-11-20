/**
 * Judgment port configuration: where the engine's Jev readings are answered,
 * where the API key comes from, and which model or alias the batteries use. Every composition root builds its port from these settings over
 * judgmentConfigFromEnv (runtime/judgment-services.ts), so an empty setting
 * means the standard TypeSafe environment variable decides.
 */
import { type ConfigSettingDefinition, intRange } from './schema-shared.js';
import type { JudgmentSettings } from './schema-types-judgment.js';
import type { ConfigSettingRow } from './schema-types.js';
import { validJudgmentFallbackSettings, validJudgmentCredentialName } from './judgment-fallback-settings.js';
import { DEFAULT_DECISION_DEADLINE_MS, MAX_DECISION_DEADLINE_MS, captureJudgmentBackendSettings, validEndpointURL } from '@goodvibes-jev/judgment/decisions';
import { captureJudgmentVolumeMonitorControl } from '../observe/judgment-volume-monitor.js';

export const judgmentConfigDefaults: { judgment: JudgmentSettings } = {
  judgment: {
    volumeMonitor: captureJudgmentVolumeMonitorControl({}),
    policy: 'Hybrid',
    endpoint: '',
    keySource: 'env',
    keyName: 'TYPESAFE_API_KEY',
    model: '',
    backend: {},
    timeoutMs: 30_000,
    decisionDeadlineMs: DEFAULT_DECISION_DEADLINE_MS,
    fallbacks: [],
  },
};

function isEndpoint(value: unknown): boolean {
  return typeof value === 'string' && (value === '' || validEndpointURL(value));
}

export const judgmentConfigSettings: (ConfigSettingDefinition | ConfigSettingRow)[] = [
  {
    key: 'judgment.volumeMonitor', type: 'object', 
    label: 'Alerts when decisions are used heavily',
    description: 'Local decision call-volume alerts. Set enabled:true and budgets:[{name:"All decisions",maxLogicalDecisions:1000,maxWireAttempts:2000}]. Optional battery/site restrict each budget; windowMs defaults to one hour, intervalMs to one minute, limit to 10000 log entries. Alerts report usage without calling models or stopping work. Disabled settings retain the optional GOODVIBES_JUDGMENT_MONITOR file override.',
    validate: value => { try { captureJudgmentVolumeMonitorControl(value); return value !== undefined; } catch { return false; } },
    closedShape: true,
    validationHint: 'object with enabled and up to 100 budgets; enabled monitoring needs at least one budget',
  },
  {
    key: 'judgment.policy', type: 'enum', 
    label: 'When the decision model is missing or fails',
    enumValues: ['Hybrid', 'Decision Model Only', 'No Decision Model'],
    description: 'Hybrid (default) uses the set decision model and, when none is set or it fails, continues without it: decisions take their fallbacks and a failure is shown once with the model, what failed and the next step. Decision Model Only stops the operation and reports when the set decision model fails. No Decision Model makes no decision-model calls. With no decision model set, every policy continues without one.',
  },
  {
    key: 'judgment.endpoint',
    label: 'Decision model server',
    type: 'string',
    description: 'Address of the decision model server the engine asks for judgments (a server that answers the decision API, POST /v1/systemone, as the hosted Jev does); empty uses TYPESAFE_BASE_URL, then the hosted endpoint. A loopback address selects a local model. While judgment.keySource is not none, change or reset it only together with judgment.keySource or judgment.keyName in one update (keep or clear the credential), or it is refused; embedded credentials, query strings and fragments are refused',
    validate: isEndpoint,
    validationHint: 'empty, or an http(s) URL without embedded credentials, query or fragment',
  },
  {
    key: 'judgment.keySource',
    label: 'Where the decision model key comes from',
    type: 'enum',
    description: 'Select where to resolve judgment.keyName: the literal enum env reads a process environment variable, secret reads a secret-store entry, and none disables authentication. This setting stores only one of those three words, never a credential or a credential reference',
    enumValues: ['env', 'secret', 'none'],
  },
  {
    key: 'judgment.keyName',
    label: 'Decision model key name',
    type: 'string',
    description: 'Primary decision credential reference, such as TYPESAFE_API_KEY or CLOUDFLARE_API_TOKEN; never an inline key value. Ignored when keySource is none',
    validate: validJudgmentCredentialName,
    validationHint: 'a credential reference name',
  },
  {
    key: 'judgment.model',
    label: 'Decision model',
    type: 'string',
    description: 'Judgment model or alias; empty uses TYPESAFE_DEFAULT_MODEL, then jev-latest',
  },
  {
    key: 'judgment.backend',
    label: 'Decision model server type and limits',
    type: 'object',
    description: 'Optional adapter (system-one, cloudflare-workers-ai or laya), maxInputBytes, maxQuestions and responseModels for the primary deployment. Limits apply to the complete request; evidence is never silently shortened. Cloudflare run URLs select their adapter automatically',
    validate: value => { try { captureJudgmentBackendSettings(value); return value !== undefined; } catch { return false; } },
    closedShape: true,
    validationHint: 'data object with optional adapter, positive maxInputBytes/maxQuestions and explicit responseModels',
  },
  {
    key: 'judgment.fallbacks',
    label: 'Backup decision models',
    type: 'object',
    description: 'Ordered decision targets with endpoint, model, keySource, keyName and optional backend capabilities. Each target may use a different decision model or adapter. keySource is env, secret or none; none requires an empty keyName. Credentials are privately resolved from references, never inline values. An empty array disables inherited fallbacks. Each target is attempted with a finite timeout; when the chain is exhausted, a decision that has a fallback takes it and any other decision stops',
    validate: validJudgmentFallbackSettings,
    validationHint: 'array of { endpoint, model, keySource: "env" | "secret" | "none", keyName } (keyName empty for "none"); no credentials in URLs or inline keys',
  },
  {
    key: 'judgment.timeoutMs',
    label: 'Give up on the decision model after (ms)',
    type: 'number',
    description: 'Finite timeout per judgment target in milliseconds; legacy 0 uses the default 30000 ms. Cancellation may stop the operation sooner',
    ...intRange(0, 2_147_483_647),
  },
  {
    key: 'judgment.decisionDeadlineMs',
    label: 'Longest a waiting decision may take (ms)',
    type: 'number',
    description: 'How long a decision that a person or a tool call waits on may take, in milliseconds, before it takes its fallback (for example asking you, or the safe default). A decision target that misses this deadline three times in a row is skipped for a minute, so the next decisions take their fallback at once',
    ...intRange(1, MAX_DECISION_DEADLINE_MS),
  },
];
