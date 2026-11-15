/**
 * trigger-tool.ts, the agent's way into the trigger family.
 *
 * One `trigger` tool: create, list, history, cancel, reset. It lets an agent
 * say "tell me when this build exits", "watch this log for errors" or "check
 * this URL every minute" and stop waiting: the daemon supervises the watcher
 * and starts an agent turn when it fires. Registering an action grant is not
 * here: a grant is a command the owner approves, so only the owner registers
 * one (the `/triggers grant` command); a trigger may then name it.
 */

import { formatRefusal, readRefusal } from '@goodvibes-jev/engine/errors';
import type { Tool, ToolDefinition } from '../types/tools.js';
import { summarizeError } from '../utils/error-display.js';
import { TriggerDefinitionError } from './validation.js';
import type { TriggerManager } from './manager.js';
import type { TriggerRecord, TriggerRunRecord } from './types.js';

export const TRIGGER_TOOL_ACTIONS = ['create', 'list', 'history', 'cancel', 'reset'] as const;
export type TriggerToolAction = (typeof TRIGGER_TOOL_ACTIONS)[number];

export const TRIGGER_TOOL_DEFINITION: ToolDefinition = {
  name: 'trigger',
  description: [
    'Watch for something and act when it happens, without holding this turn open. The daemon supervises the watcher; when it fires, an agent turn starts with what was seen.',
    'Kinds (definition.spec.kind): "on-exit" runs a command and fires once when it ends (exit code, signal and output tail included); "stream" runs a long-lived command and fires on output lines matching a pattern (batched); "condition" checks a URL, file or command on an interval and fires when a rule holds (change, value, threshold, debounce-n, ...).',
    'Commands are argv: command plus args, never a shell line. Actions: create (definition), list, history (id), cancel (id), reset (id, after its breaker opened).',
    'Example: {"action":"create","definition":{"id":"build","label":"Build finished","spec":{"kind":"on-exit","command":"npm","args":["run","build"]}}}.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...TRIGGER_TOOL_ACTIONS] },
      id: { type: 'string', description: 'The trigger id, for history, cancel and reset.' },
      definition: {
        type: 'object',
        description: 'For create: { id, label, description?, spec, action? }. spec.kind is on-exit | stream | condition. action defaults to an agent turn ({"kind":"agent-turn","prompt"?}); {"kind":"action-grant","grantId","digest"} runs a command the owner registered.',
      },
      limit: { type: 'number', description: 'For history: how many of the newest runs to return (default 20).' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  sideEffects: ['exec', 'agent', 'state'],
  category: 'execute',
  subjects: { commands: ['definition.spec.command', 'definition.spec.probe.command'] },
  concurrency: 'serial',
};

/** What an agent reads about one trigger: never its observations or a command's output. */
export function summarizeTrigger(record: TriggerRecord): Record<string, unknown> {
  const spec = record.definition.spec;
  const watching = spec.kind === 'condition'
    ? `${spec.probe.kind} probe, ${spec.rule.kind} rule${spec.intervalMs !== undefined ? `, every ${spec.intervalMs}ms` : ''}`
    : `${[spec.command, ...(spec.args ?? [])].join(' ')}${spec.kind === 'stream' ? ` (lines matching ${spec.match.pattern})` : ''}`;
  return {
    id: record.definition.id,
    label: record.definition.label,
    kind: spec.kind,
    watching,
    state: record.state,
    firedCount: record.firedCount,
    ...(record.lastFiredAt !== undefined ? { lastFiredAt: new Date(record.lastFiredAt).toISOString() } : {}),
    ...(record.nextCheckAt !== undefined ? { nextCheckAt: new Date(record.nextCheckAt).toISOString() } : {}),
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
    ...(record.droppedLines > 0 ? { droppedLines: record.droppedLines } : {}),
    ...(record.state === 'circuit-open' ? { next: 'reset the trigger once the cause is fixed' } : {}),
  };
}

function summarizeRun(run: TriggerRunRecord): Record<string, unknown> {
  return {
    at: new Date(run.at).toISOString(),
    outcome: run.outcome,
    ...(run.detail !== undefined ? { detail: run.detail } : {}),
    ...(run.actionResult !== undefined ? { actionResult: run.actionResult } : {}),
    ...(run.termination ? { termination: { state: run.termination.state, reason: run.termination.reason, exitCode: run.termination.exitCode, signal: run.termination.signal, observed: run.termination.observed } } : {}),
  };
}

function fail(error: unknown): { success: false; error: string } {
  if (error instanceof TriggerDefinitionError) return { success: false, error: `The definition was refused: ${error.message}. Fix that field and create again.` };
  const carried = readRefusal(error);
  return { success: false, error: carried ? formatRefusal(carried) : summarizeError(error) };
}

export interface TriggerToolOptions {
  /** The session making the call; a trigger created from it is reaped when that session is gone. */
  readonly resolveSessionId?: (() => string | undefined) | undefined;
}

export function createTriggerTool(manager: TriggerManager, options: TriggerToolOptions = {}): Tool {
  return {
    definition: TRIGGER_TOOL_DEFINITION,
    async execute(args: Record<string, unknown>) {
      const action = args['action'];
      if (typeof action !== 'string' || !(TRIGGER_TOOL_ACTIONS as readonly string[]).includes(action)) {
        return { success: false, error: `action must be one of ${TRIGGER_TOOL_ACTIONS.join(', ')}.` };
      }
      const id = typeof args['id'] === 'string' ? args['id'] : undefined;
      try {
        switch (action as TriggerToolAction) {
          case 'list': {
            const records = manager.list();
            return { success: true, output: JSON.stringify({ ownership: manager.executionOwnership, triggers: records.map(summarizeTrigger) }) };
          }
          case 'create': {
            const definition = args['definition'];
            if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
              return { success: false, error: 'create needs a definition object: { id, label, spec, action? }.' };
            }
            const input = definition as Record<string, unknown>;
            const owner = input['ownerSessionId'] ?? options.resolveSessionId?.();
            const record = await manager.create({
              ...input,
              action: input['action'] ?? { kind: 'agent-turn' },
              ...(typeof owner === 'string' && owner.length > 0 ? { ownerSessionId: owner } : {}),
            });
            return { success: true, output: JSON.stringify({ created: summarizeTrigger(record) }) };
          }
          case 'history': {
            if (!id) return { success: false, error: 'history needs the trigger id.' };
            const record = manager.get(id);
            if (!record) return { success: false, error: `There is no trigger "${id}". List the triggers to see their ids.` };
            const limit = typeof args['limit'] === 'number' && Number.isInteger(args['limit']) && args['limit'] > 0 ? args['limit'] : 20;
            return { success: true, output: JSON.stringify({ trigger: summarizeTrigger(record), runs: record.runs.slice(-limit).map(summarizeRun) }) };
          }
          case 'cancel': {
            if (!id) return { success: false, error: 'cancel needs the trigger id.' };
            const record = manager.cancel(id);
            if (!record) return { success: false, error: `There is no trigger "${id}". List the triggers to see their ids.` };
            return { success: true, output: JSON.stringify({ cancelled: summarizeTrigger(record) }) };
          }
          case 'reset': {
            if (!id) return { success: false, error: 'reset needs the trigger id.' };
            const refusedBecause = manager.resetRefusal(id);
            if (refusedBecause) return { success: false, error: `The trigger was not reset: ${refusedBecause}.` };
            const record = manager.reset(id);
            if (!record) return { success: false, error: `There is no trigger "${id}". List the triggers to see their ids.` };
            return { success: true, output: JSON.stringify({ reset: summarizeTrigger(record) }) };
          }
        }
      } catch (error) {
        return fail(error);
      }
      return { success: false, error: 'Unknown trigger action.' };
    },
  };
}
