import { captureJudgmentFallbackSettings, validJudgmentFallbackSettings, validJudgmentCredentialName } from './judgment-fallback-settings.js';
import { isSecretBearingConfigKey } from './secret-bearing-config-keys.js';
import type { ConfigSetting } from './schema-types.js';

/** Structured credential references stay in config; scalar credential values use the secret store. */
export const STRUCTURED_CREDENTIAL_CONFIG_DECLARATIONS = Object.freeze([
  Object.freeze({
    key: 'judgment.fallbacks',
    kind: 'structured-reference',
    type: 'object',
    validate: validJudgmentFallbackSettings,
  }),
]);

export function isStructuredCredentialReferenceConfigKey(key: string): boolean {
  return STRUCTURED_CREDENTIAL_CONFIG_DECLARATIONS.some(declaration => declaration.key === key);
}

/** Detach only the exact validated reference shape. Never resolve a credential or invoke an accessor. */
export function captureStructuredCredentialReferenceConfigValue(key: string, value: unknown): ReturnType<typeof captureJudgmentFallbackSettings> {
  if (key !== 'judgment.fallbacks' || value === undefined) throw new Error('Invalid structured credential references');
  return captureJudgmentFallbackSettings(value);
}

/** The offline gate checks the declaration's actual schema contract, not a fabricated semantic reading. */
export function structuredCredentialConfigSchemaFailures(schema: readonly Pick<ConfigSetting, 'key' | 'type' | 'default' | 'validate'>[]): readonly { readonly key: string; readonly reason: string }[] {
  const failures: { key: string; reason: string }[] = [];
  for (const declaration of STRUCTURED_CREDENTIAL_CONFIG_DECLARATIONS) {
    const entries = schema.filter(setting => setting.key === declaration.key);
    const entry = entries[0];
    if (entries.length !== 1 || !entry || entry.type !== declaration.type || entry.validate !== declaration.validate
      || !Array.isArray(entry.default) || entry.default.length !== 0 || !declaration.validate(entry.default)
      || isSecretBearingConfigKey(declaration.key)) {
      failures.push({ key: declaration.key, reason: 'Structured credential references require their exact object schema, canonical validator, empty array default and separate scalar-secret routing.' });
    }
  }
  const scalar = schema.filter(setting => setting.key === 'judgment.keyName');
  const reference = scalar[0];
  if (scalar.length !== 1 || !reference || reference.type !== 'string' || reference.validate !== validJudgmentCredentialName
    || reference.default !== 'TYPESAFE_API_KEY' || isSecretBearingConfigKey('judgment.keyName'))
    failures.push({ key: 'judgment.keyName', reason: 'A scalar reference requires the canonical name validator, default name and separate secret storage.' });
  return failures;
}

/** Scalar references are names, not secret values, and must survive the plaintext sweep. */
export function isScalarCredentialReferenceConfigKey(key: string): boolean {
  return key === 'judgment.keyName';
}

export function assertScalarCredentialReferenceConfigValue(key: string, value: unknown): void {
  if (!isScalarCredentialReferenceConfigKey(key) || !validJudgmentCredentialName(value))
    throw new Error('Invalid credential reference name');
}
