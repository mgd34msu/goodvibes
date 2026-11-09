import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '@goodvibes-jev/engine/platform/platform/config';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
export type RollbackAction = () => Promise<void> | void;
export function createOnboardingFileHelpers(
  ports: {
    readonly write: (path: string, contents: string) => void;
    readonly describeError: (error: unknown) => string;
  } = { write: (path, contents) => atomicWriteFileSync(path, contents, { mkdirp: true }), describeError: summarizeError },
) {
  function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  function readJsonObject(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isPlainObject(parsed)) throw new Error(`Expected an object JSON payload at ${path}.`);
    return parsed;
  }
  function writeJsonObject(path: string, payload: Record<string, unknown>): void {
    ports.write(path, `${JSON.stringify(payload, null, 2)}\n`);
  }
  function setNestedValue(root: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
    const parts = key.split('.');
    const next = structuredClone(root);
    let cursor: Record<string, unknown> = next;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index]!;
      const existing = cursor[part];
      if (!isPlainObject(existing)) cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]!] = structuredClone(value);
    return next;
  }
  function restoreFile(path: string, previous: string | null, reload?: (() => void) | undefined): void {
    if (previous === null) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      ports.write(path, previous);
    }
    reload?.();
  }
  function snapshotFileRollback(path: string, reload?: (() => void) | undefined): RollbackAction {
    const previous = existsSync(path) ? readFileSync(path, 'utf-8') : null;
    return () => restoreFile(path, previous, reload);
  }
  async function runRollbacks(rollbacks: readonly RollbackAction[]): Promise<readonly string[]> {
    const errors: string[] = [];
    for (const rollback of [...rollbacks].reverse()) {
      try {
        await rollback();
      } catch (error) {
        errors.push(ports.describeError(error));
      }
    }
    return errors;
  }
  return { isPlainObject, readJsonObject, writeJsonObject, setNestedValue, restoreFile, snapshotFileRollback, runRollbacks };
}
