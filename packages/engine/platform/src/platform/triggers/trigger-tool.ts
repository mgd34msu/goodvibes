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
import { TriggerManager } from './manager.js';
import { localTriggerOperations, type TriggerOperations } from './operations.js';

export const TRIGGER_TOOL_ACTIONS = ['create', 'list', 'history', 'cancel', 'reset'] as const;
export type TriggerToolAction = (typeof TRIGGER_TOOL_ACTIONS)[number];

export const TRIGGER_TOOL_DEFINITION: ToolDefinition = {
  name: 'trigger',
  description: [
    'Watch for something and act when it happens, without holding this turn open. The daemon supervises the watcher; when it fires, an agent turn starts with what was seen.',
    'Kinds (definition.spec.kind): "on-exit" runs a command and fires once when it ends (exit code, signal and output tail included); "stream" runs a long-lived command and fires on output lines matching a pattern (batched); "condition" checks a URL, file, command or a reading platform tool (probe {"kind":"platform-tool","tool":"read","input":{...}}) on an interval and fires when a rule holds (change, value, threshold, debounce-n, ...).',
    'Commands are argv: command plus args, never a shell line. Actions: create (definition), list, history (id), cancel (id), reset (id, after its breaker opened).',
    'Example: {"action":"create","definition":{"id":"build","label":"Build finished","spec":{"kind":"on-exit","command":"npm","args":["run","build"]}}}.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...TRIGGER_TOOL_ACTIONS], description: 'create (with definition), list, history (id), cancel (id), or reset (id, after its breaker opened).' },
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
  // list and history only read; create, cancel and reset change what runs.
  readModes: { field: 'action', values: ['list', 'history'] },
  subjects: { commands: ['definition.spec.command', 'definition.spec.probe.command'] },
  concurrency: 'serial',
};

function fail(error: unknown): { success: false; error: string } {
  if (error instanceof TriggerDefinitionError) return { success: false, error: `The definition was refused: ${error.message}. Fix that field and create again.` };
  const carried = readRefusal(error);
  return { success: false, error: carried ? formatRefusal(carried) : summarizeError(error) };
}

export interface TriggerToolOptions {
  /** The session making the call; a trigger created from it on a local supervisor is reaped when that session is gone. */
  readonly resolveSessionId?: (() => string | undefined) | undefined;
}

/**
 * The `trigger` tool over the supervisor in this process (a `TriggerManager`)
 * or over the host's supervisor (`remoteTriggerOperations`).
 */
export function createTriggerTool(supervisor: TriggerManager | TriggerOperations, options: TriggerToolOptions = {}): Tool {
  const local = supervisor instanceof TriggerManager;
  const operations = local ? localTriggerOperations(supervisor) : supervisor;
  // Only a session of the supervising process is one its owner-reaping can see; a trigger made
  // from an app that leaves triggers to the daemon is kept until it is cancelled.
  const sessionOwner = local ? options.resolveSessionId : undefined;
  return {
    definition: TRIGGER_TOOL_DEFINITION,
    async execute(args: Record<string, unknown>) {
      const action = args['action'];
      if (typeof action !== 'string' || !(TRIGGER_TOOL_ACTIONS as readonly string[]).includes(action)) {
        return { success: false, error: `action must be one of ${TRIGGER_TOOL_ACTIONS.join(', ')}.` };
      }
      const id = typeof args['id'] === 'string' && args['id'].length > 0 ? args['id'] : undefined;
      try {
        switch (action as TriggerToolAction) {
          case 'list':
            return { success: true, output: JSON.stringify(await operations.list()) };
          case 'create': {
            const definition = args['definition'];
            if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
              return { success: false, error: 'create needs a definition object: { id, label, spec, action? }.' };
            }
            const input = definition as Record<string, unknown>;
            const owner = input['ownerSessionId'] ?? sessionOwner?.();
            const created = await operations.create({
              ...input,
              ...(typeof owner === 'string' && owner.length > 0 ? { ownerSessionId: owner } : {}),
            });
            return { success: true, output: JSON.stringify({ created }) };
          }
          case 'history': {
            if (!id) return { success: false, error: 'history needs the trigger id.' };
            const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined;
            return { success: true, output: JSON.stringify(await operations.history(id, limit)) };
          }
          case 'cancel':
            if (!id) return { success: false, error: 'cancel needs the trigger id.' };
            return { success: true, output: JSON.stringify({ cancelled: await operations.cancel(id) }) };
          case 'reset':
            if (!id) return { success: false, error: 'reset needs the trigger id.' };
            return { success: true, output: JSON.stringify({ reset: await operations.reset(id) }) };
        }
      } catch (error) {
        return fail(error);
      }
      return { success: false, error: 'Unknown trigger action.' };
    },
  };
}
