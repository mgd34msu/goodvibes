/**
 * record-of-decided-call.ts: one act, one question. A tool that performs an act the owner's gate decided (a calendar
 * event made through the daemon's `calendar.events.create`, nested in the tool's call) writes a record of it as part of
 * that act: the receipt a Personal Ops lane lists. That write is the record of the decided call, made inside that call,
 * and raises no question of its own (capability-tools.ts `daemonCapabilityRunner`). Only a save made inside this scope,
 * in a tool call in which a nested act was admitted and ran, is such a record; any other save, the model's own
 * included, is its own act and is decided as one.
 *
 * The scope is set by code (the receipt writer), never by an argument a model sends: nothing a model says can make a
 * save a record.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolExecuteOptions } from '@goodvibes/engine/platform/platform/types';

const recordScope = new AsyncLocalStorage<true>();

/**
 * How a record that was not saved starts its words: the record skips the question, never a refusing rule or plan
 * mode, and the act it records already ran (the receipt writer reports the act as done and says this after it).
 */
export const RECORD_NOT_SAVED = 'Its record was not saved';
/** The executing tool calls (by their options) in which a nested act was admitted by the gate and ran. */
const decidedActs = new WeakSet<ToolExecuteOptions>();

/** Run `write` as the record of the act its tool call performed (a receipt written after it). */
export function asRecordOfDecidedCall<T>(write: () => T): T {
  return recordScope.run(true, write);
}

/** Whether the code running now writes the record of a decided act. */
export function inRecordOfDecidedCall(): boolean {
  return recordScope.getStore() === true;
}

/** Note that a nested act of this tool call was admitted and ran (or was sent and its outcome is not known). */
export function noteDecidedAct(executing: ToolExecuteOptions): void {
  decidedActs.add(executing);
}

/** Whether a nested act of this tool call was admitted and ran. */
export function hasDecidedAct(executing: ToolExecuteOptions | undefined): boolean {
  return executing !== undefined && decidedActs.has(executing);
}
