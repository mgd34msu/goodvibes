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
import { captureJudgmentBackendSettings, validEndpointURL } from '@goodvibes/judgment/decisions';
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
    fallbacks: [],
    setAside: {},
    noDecisionModel: false,
  },
};

function isEndpoint(value: unknown): boolean {
  return typeof value === 'string' && (value === '' || validEndpointURL(value));
}

const SET_ASIDE_FIELDS = new Set(['endpoint', 'model', 'keySource', 'keyName', 'backend', 'fallbacks']);

/** `judgment.setAside`: an object of the primary decision model's own settings, each valid as its own key is, nothing else. */
function validSetAside(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([field]) => !SET_ASIDE_FIELDS.has(field))) return false;
  const set = value as Record<string, unknown>;
  if (set['endpoint'] !== undefined && !isEndpoint(set['endpoint'])) return false;
  if (set['model'] !== undefined && typeof set['model'] !== 'string') return false;
  if (set['keySource'] !== undefined && set['keySource'] !== 'env' && set['keySource'] !== 'secret' && set['keySource'] !== 'none') return false;
  if (set['keyName'] !== undefined && set['keyName'] !== '' && !validJudgmentCredentialName(set['keyName'])) return false;
  if (set['fallbacks'] !== undefined && !validJudgmentFallbackSettings(set['fallbacks'])) return false;
  if (set['backend'] !== undefined) { try { captureJudgmentBackendSettings(set['backend']); } catch { return false; } }
  return true;
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
    description: 'Who answers is set in one place, When GoodVibes asks (permissions.mode); this setting only says what happens while a set decision model fails, or that none is used. Hybrid (default): while it fails, each decision takes its own fallback (a permission call comes to you instead, or is held to the end of the run in Just vibes), and the failure is shown once with the model, what failed and the next step. Decision Model Only: while it fails, a call it would have decided is refused with its error and the turn goes on. No Decision Model: no decision model is asked, as with none set, and every decision takes its fallback (a permission call comes to you, or is held in Just vibes). YOLO asks no decision model, so this setting does not change it.',
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
    description: 'Where the decision model\'s key comes from. Environment variable: the variable named in Decision model key name. Secret store: the secret of that name in GoodVibes\' secret store. No key is sent: for a decision model server that needs none. Only this choice is stored here, never a key',
    enumValues: ['env', 'secret', 'none'],
    // `none` sends the decision model no key at all (a server that needs none); it is not "no decision model".
    enumLabels: { env: 'Environment variable', secret: 'Secret store', none: 'No key is sent' },
  },
  {
    key: 'judgment.keyName',
    label: 'Decision model key name',
    type: 'string',
    description: 'Primary decision credential reference, such as TYPESAFE_API_KEY or CLOUDFLARE_API_TOKEN; never an inline key value. Not used when the key source is No key is sent',
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
    description: 'How long one attempt at one decision target may go without its answer before that target is treated as not answering, so the next target or the decision\'s own fallback is used; 0 uses 30000 ms. It exists for a server that took the request and never answered, or a connection lost without a reset: the decision API sends its whole answer at once, so nothing else can tell such an attempt from a slow one. Decisions are sized to what the model accepts and answer in seconds; raise it for a slow local model. Cancellation stops the operation sooner',
    ...intRange(0, 2_147_483_647),
  },
  {
    key: 'judgment.setAside',
    label: 'Decision model set aside',
    type: 'object',
    description: 'The decision model settings an earlier version held while decision models were switched off (No Decision Model): moved here, as they were, when that choice was carried to the mode Ask me with no decision model set, so nothing is sent to a decision model until you choose one. Choosing a decision model in Settings offers them back ("Use the decision model you had before"), which sets them again and empties this. Empty when nothing is set aside. Holds the names of credentials, never a credential',
    validate: validSetAside,
    closedShape: true,
    validationHint: 'object with any of endpoint, model, keySource, keyName, backend and fallbacks, each valid as its judgment.* setting',
  },
  {
    key: 'judgment.noDecisionModel',
    label: 'No decision model',
    type: 'boolean',
    description: 'On: no decision model is asked, whatever this computer\'s environment holds (a decision model key or server address there is not used), so nothing is sent to one; every decision takes its fallback (Jev decides asks you as Ask me does, Just vibes holds the call to the end of the run). Choosing No decision model in Settings turns it on, as does carrying forward an earlier version\'s No Decision Model; choosing a decision model in Settings turns it off. Off (the default): a decision model set here or found in the environment is used',
  },
];
