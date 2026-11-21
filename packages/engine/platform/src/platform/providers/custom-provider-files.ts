/**
 * The custom provider files (`*.json` in the providers directory): their
 * validation, shared with the loader that builds the providers, and a reading
 * of just the names a loaded set would register, for a command that only says
 * which provider a model reference names (`status`) without building any.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The name and display name of a custom provider a load would register. */
export interface CustomProviderName {
  readonly name: string;
  readonly displayName: string;
  /** The environment variable its file names for the API key (`apiKeyEnv`), when it names one. */
  readonly apiKeyEnv?: string | undefined;
}

/**
 * Validate a single parsed JSON object against the CustomProviderConfig schema.
 * Returns { valid, errors }, errors is empty when valid.
 */
export function validateCustomProvider(data: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { valid: false, errors: ['Root value must be a JSON object'] };
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || obj['name'].trim() === '') {
    errors.push('"name" must be a non-empty string');
  } else if (/[:\s]/.test(obj['name'])) {
    errors.push('"name" must not contain ":" or spaces, because models are addressed as name:model');
  }

  if (typeof obj['displayName'] !== 'string' || obj['displayName'].trim() === '') {
    errors.push('"displayName" must be a non-empty string');
  }

  if (obj['type'] !== 'openai-compat' && obj['type'] !== 'anthropic-compat') {
    errors.push('"type" must be "openai-compat" or "anthropic-compat"');
  }

  if (typeof obj['baseURL'] !== 'string' || obj['baseURL'].trim() === '') {
    errors.push('"baseURL" must be a non-empty string');
  }

  for (const field of ['apiKey', 'apiKeyEnv']) {
    if (obj[field] !== undefined && typeof obj[field] !== 'string') {
      errors.push(`"${field}", when given, must be a string`);
    }
  }

  if (obj['defaultHeaders'] !== undefined) {
    const headers = obj['defaultHeaders'];
    if (
      typeof headers !== 'object' || headers === null || Array.isArray(headers)
      || !Object.values(headers).every((value) => typeof value === 'string')
    ) {
      errors.push('"defaultHeaders", when given, must be an object of string values');
    }
  }

  if (obj['reasoningFormat'] !== undefined) {
    if (!['mercury', 'openrouter', 'llamacpp', 'none'].includes(obj['reasoningFormat'] as string)) {
      errors.push('"reasoningFormat" must be "mercury", "openrouter", "llamacpp", or "none"');
    }
  }

  if (!Array.isArray(obj['models']) || (obj['models'] as unknown[]).length === 0) {
    errors.push('"models" must be a non-empty array');
  } else {
    const models = obj['models'] as unknown[];
    models.forEach((m, i) => {
      if (typeof m !== 'object' || m === null || Array.isArray(m)) {
        errors.push(`models[${i}]: must be an object`);
        return;
      }
      const model = m as Record<string, unknown>;
      if (typeof model['id'] !== 'string' || model['id'].trim() === '') {
        errors.push(`models[${i}]: "id" must be a non-empty string`);
      }
      if (typeof model['displayName'] !== 'string' || model['displayName'].trim() === '') {
        errors.push(`models[${i}]: "displayName" must be a non-empty string`);
      }
      if (model['contextWindow'] !== undefined && (typeof model['contextWindow'] !== 'number' || !Number.isFinite(model['contextWindow']) || model['contextWindow'] <= 0)) {
        errors.push(`models[${i}]: "contextWindow", when given, must be a positive number`);
      }
      if (typeof model['capabilities'] !== 'object' || model['capabilities'] === null) {
        errors.push(`models[${i}]: "capabilities" must be an object`);
      } else {
        const caps = model['capabilities'] as Record<string, unknown>;
        for (const cap of ['toolCalling', 'codeEditing', 'reasoning', 'multimodal']) {
          if (typeof caps[cap] !== 'boolean') {
            errors.push(`models[${i}]: capabilities.${cap} must be a boolean`);
          }
        }
      }
      if (
        model['reasoningEffort'] !== undefined
        && (!Array.isArray(model['reasoningEffort']) || !model['reasoningEffort'].every((level) => typeof level === 'string'))
      ) {
        errors.push(`models[${i}]: "reasoningEffort", when given, must be an array of strings`);
      }
      if (model['tier'] !== undefined && !['free', 'standard', 'premium'].includes(model['tier'] as string)) {
        errors.push(`models[${i}]: "tier", when given, must be "free", "standard", or "premium"`);
      }
      if (model['pricing'] !== undefined) {
        const pricing = model['pricing'];
        if (typeof pricing !== 'object' || pricing === null || Array.isArray(pricing)) {
          errors.push(`models[${i}]: "pricing" must be an object with input/output rates (USD per 1M tokens)`);
        } else {
          const rates = pricing as Record<string, unknown>;
          for (const field of ['input', 'output']) {
            if (typeof rates[field] !== 'number' || !Number.isFinite(rates[field] as number) || (rates[field] as number) < 0) {
              errors.push(`models[${i}]: pricing.${field} must be a finite number >= 0 (USD per 1M tokens)`);
            }
          }
          for (const field of ['cacheRead', 'cacheWrite']) {
            if (rates[field] !== undefined && (typeof rates[field] !== 'number' || !Number.isFinite(rates[field] as number) || (rates[field] as number) < 0)) {
              errors.push(`models[${i}]: pricing.${field} must be a finite number >= 0 (USD per 1M tokens) when present`);
            }
          }
        }
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * The providers a load of `providersDir` registers, by name, in the loader's
 * order and with its skips: a file that is not valid JSON or fails
 * validation, a built-in name (`reservedNames`), and a second file naming a
 * provider already defined. A missing directory has none. Reads only; the
 * loader creates the directory.
 */
export function readCustomProviderNames(providersDir: string, reservedNames: ReadonlySet<string>): CustomProviderName[] {
  let entries: string[];
  try {
    entries = readdirSync(providersDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const names: CustomProviderName[] = [];
  const seen = new Set<string>();
  for (const filename of entries) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(join(providersDir, filename), 'utf-8')); }
    catch { continue; }
    if (!validateCustomProvider(parsed).valid) continue;
    const { name, displayName, apiKeyEnv } = parsed as CustomProviderName;
    if (reservedNames.has(name) || seen.has(name)) continue;
    seen.add(name);
    names.push({ name, displayName, ...(typeof apiKeyEnv === 'string' && apiKeyEnv.length > 0 ? { apiKeyEnv } : {}) });
  }
  return names;
}
