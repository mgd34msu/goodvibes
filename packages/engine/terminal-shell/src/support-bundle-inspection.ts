import { readFileSync } from 'node:fs';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { isRedactedValue } from './cli-redaction.js';

/** A partially redacted object cannot restore a configuration setting faithfully. */
export function containsRedactedValue(value: unknown): boolean {
  if (isRedactedValue(value)) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsRedactedValue);
}
export interface BundleInspectSummary {
  readonly type: string;
  readonly version: string;
  readonly path: string;
  readonly capturedAt: number | null;
  readonly configKeys: number;
  readonly redactedConfigPaths: readonly string[];
  readonly hasDiagnostics: boolean;
}
export function formatJsonOrText(
  runtime: {
    readonly cli: {
      readonly flags: {
        readonly outputFormat?: string | undefined;
      };
    };
  },
  value: unknown,
  text: string,
): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}
export function getNestedValue(source: unknown, key: string): unknown {
  let cursor = source;
  for (const part of key.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(cursor, part);
    if (!descriptor || !('value' in descriptor)) return undefined;
    cursor = descriptor.value;
  }
  return cursor;
}
export function readJsonFile(path: string):
  | {
      readonly ok: true;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly error: string;
    } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: summarizeError(error) };
  }
}
export function inspectBundle(
  path: string,
  parsed: Record<string, unknown>,
  schema: readonly {
    readonly key: string;
  }[],
): BundleInspectSummary {
  return {
    type: String(parsed['type'] ?? 'unknown'),
    version: String(parsed['version'] ?? 'unknown'),
    path,
    capturedAt: typeof parsed['capturedAt'] === 'number' ? parsed['capturedAt'] : null,
    configKeys:
      parsed['config'] && typeof parsed['config'] === 'object'
        ? schema.filter((setting) => getNestedValue(parsed['config'], setting.key) !== undefined).length
        : 0,
    redactedConfigPaths: Array.isArray(
      (
        parsed['redaction'] as
          | {
              redactedConfigPaths?: unknown | undefined;
            }
          | undefined
      )?.redactedConfigPaths,
    )
      ? (
          parsed['redaction'] as {
            redactedConfigPaths: string[];
          }
        ).redactedConfigPaths
      : [],
    hasDiagnostics: Boolean(parsed['diagnostics'] && typeof parsed['diagnostics'] === 'object'),
  };
}
