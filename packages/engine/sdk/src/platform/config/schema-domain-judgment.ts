/**
 * Judgment port configuration: where the engine's Jev readings are answered,
 * where the API key comes from, and which model or alias the batteries use. Every composition root builds its port from these settings over
 * judgmentConfigFromEnv (runtime/judgment-services.ts), so an empty setting
 * means the standard TypeSafe environment variable decides.
 */
import { type ConfigSettingDefinition, intRange } from './schema-shared.js';
import type { JudgmentSettings } from './schema-types-judgment.js';
import type { ConfigSetting } from './schema-types.js';
import { validJudgmentFallbackSettings, validJudgmentCredentialName } from './judgment-fallback-settings.js';
import { captureJudgmentBackendSettings } from '@goodvibes-jev/judgment/decisions';

export const judgmentConfigDefaults: { judgment: JudgmentSettings } = {
  judgment: {
    policy: 'Default - On',
    endpoint: '',
    keySource: 'env',
    keyName: 'TYPESAFE_API_KEY',
    model: '',
    backend: {},
    timeoutMs: 30_000,
    fallbacks: [],
  },
};

function isEndpoint(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export const judgmentConfigSettings: (ConfigSettingDefinition | ConfigSetting)[] = [
  {
    key: 'judgment.policy', type: 'enum', default: 'Default - On',
    enumValues: ['Default - On', 'Preferred', 'Classic - Off'],
    description: 'Default - On requires available decision models. Preferred tries the configured chain and falls back to Classic only on availability exhaustion. Classic - Off makes no decision-model calls, uses owner-approved tool execution and ordinary completion, and exposes decision-only feature limitations.',
  },
  {
    key: 'judgment.endpoint',
    type: 'string',
    default: '',
    description: 'System One endpoint the engine asks for judgments; empty uses TYPESAFE_BASE_URL, then the hosted endpoint. A loopback address selects a local model',
    validate: isEndpoint,
    validationHint: 'empty, or an http(s) URL',
  },
  {
    key: 'judgment.keySource',
    type: 'enum',
    default: 'env',
    description: 'Select where to resolve judgment.keyName: the literal enum env reads a process environment variable, secret reads a secret-store entry, and none disables authentication. This setting stores only one of those three words, never a credential or a credential reference',
    enumValues: ['env', 'secret', 'none'],
  },
  {
    key: 'judgment.keyName',
    type: 'string',
    default: 'TYPESAFE_API_KEY',
    description: 'Primary decision credential reference, such as TYPESAFE_API_KEY or CLOUDFLARE_API_TOKEN; never an inline key value. Ignored when keySource is none',
    validate: validJudgmentCredentialName,
    validationHint: 'a credential reference name',
  },
  {
    key: 'judgment.model',
    type: 'string',
    default: '',
    description: 'Judgment model or alias; empty uses TYPESAFE_DEFAULT_MODEL, then jev-latest',
  },
  {
    key: 'judgment.backend',
    type: 'object',
    default: {},
    description: 'Optional adapter (system-one, cloudflare-workers-ai or laya), maxInputBytes, maxQuestions and responseModels for the primary deployment. Limits apply to the complete request; evidence is never silently shortened. Cloudflare run URLs select their adapter automatically',
    validate: value => { try { captureJudgmentBackendSettings(value); return value !== undefined; } catch { return false; } },
    validationHint: 'data object with optional adapter, positive maxInputBytes/maxQuestions and explicit responseModels',
  },
  {
    key: 'judgment.fallbacks',
    type: 'object',
    default: [],
    description: 'Ordered decision targets with endpoint, model, keySource, keyName and optional backend capabilities. Each target may use a different decision model or adapter. keySource is env, secret or none; none requires an empty keyName. Credentials are privately resolved from references, never inline values. An empty array disables inherited fallbacks. Each target is attempted once with a finite deadline; exhaustion halts the operation',
    validate: validJudgmentFallbackSettings,
    validationHint: 'array of { endpoint, model, keySource: "env" | "secret", keyName }; no credentials in URLs or inline keys',
  },
  {
    key: 'judgment.timeoutMs',
    type: 'number',
    default: 30_000,
    description: 'Finite timeout per judgment target in milliseconds; legacy 0 uses the default 30000 ms. Cancellation may stop the operation sooner',
    ...intRange(0, 2_147_483_647),
  },
];
