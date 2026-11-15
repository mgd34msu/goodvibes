/**
 * Memory record ids: `mem_<base36 creation time>_<8 hex>`. The store generates
 * one for an add that names none; a remote client generates one per add so the
 * host recognises a resend of the same add.
 */
import { randomUUID } from 'node:crypto';

export const MEMORY_ID_SHAPE = /^mem_[a-z0-9]+_[a-f0-9]{8}$/;

/** A new record id for a record created at `at`. */
export function newMemoryId(at: number = Date.now()): string {
  return `mem_${at.toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
