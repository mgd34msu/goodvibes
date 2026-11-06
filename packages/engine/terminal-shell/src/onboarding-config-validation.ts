import { CONFIG_SCHEMA, DEFAULT_CONFIG, isMalformedGoodVibesSecretReferenceValue } from '@goodvibes-jev/engine/sdk/platform/config';
import { createOnboardingFileHelpers } from './onboarding-file-helpers.js';
const { isPlainObject } = createOnboardingFileHelpers();
export function createOnboardingConfigValidator<Operation extends { readonly key: string; readonly value: unknown }>(policy: {
  readonly separator: string;
  readonly validateExtension?: ((operation: Operation) => boolean) | undefined;
}) {
  function validateConfigValue(operation: Operation): void {
    if (typeof operation.value === 'string' && isMalformedGoodVibesSecretReferenceValue(operation.value)) {
      throw new Error(`Config key ${operation.key} only accepts goodvibes://secrets/... secret references.`);
    }

    // Feature enablement arrives as plain domain settings writes (e.g.
    // sandbox.enabled, controlPlane.gateway), validated by the schema path below
    // like any other key, there is no separate enablement namespace.
    if (policy.validateExtension?.(operation)) return;
    const schema = CONFIG_SCHEMA.find((entry) => entry.key === operation.key);
    if (!schema) {
      const defaultValue = operation.key
        .split('.')
        .reduce<unknown>(
          (cursor, part) => (isPlainObject(cursor) && Object.hasOwn(cursor, part) ? cursor[part] : undefined),
          DEFAULT_CONFIG,
        );
      if (defaultValue === undefined) throw new Error(`Unknown config key${policy.separator}${operation.key}`);
      if (typeof defaultValue === 'boolean' && typeof operation.value !== 'boolean') {
        throw new Error(`Config key ${operation.key} expects a boolean value.`);
      }
      if (typeof defaultValue === 'number' && typeof operation.value !== 'number') {
        throw new Error(`Config key ${operation.key} expects a numeric value.`);
      }
      if (typeof defaultValue === 'string' && typeof operation.value !== 'string') {
        throw new Error(`Config key ${operation.key} expects a string value.`);
      }
      return;
    }
    const stringValue = typeof operation.value === 'string' ? operation.value : null;

    if (schema.type === 'boolean' && typeof operation.value !== 'boolean') {
      throw new Error(`Config key ${operation.key} expects a boolean value.`);
    }

    if (schema.type === 'number' && typeof operation.value !== 'number') {
      throw new Error(`Config key ${operation.key} expects a numeric value.`);
    }

    if ((schema.type === 'string' || schema.type === 'enum') && stringValue === null) {
      throw new Error(`Config key ${operation.key} expects a string value.`);
    }

    if (schema.type === 'enum' && schema.enumValues && stringValue !== null && !schema.enumValues.includes(stringValue)) {
      throw new Error(`Invalid value for ${operation.key}${policy.separator}${String(operation.value)}.`);
    }

    if (schema.validate && !schema.validate(operation.value)) {
      throw new Error(`Invalid value for ${operation.key}${policy.separator}${String(operation.value)}.`);
    }
  }
  return { validateConfigValue };
}
