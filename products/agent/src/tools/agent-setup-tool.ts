import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolInvocation, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { randomUUID } from 'node:crypto';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createSetupSmokeReferenceCapture, resolveSetupSmokeNativeEvidence } from './agent-setup-smoke-reference.ts';
import { runSetupInstallSmoke } from './agent-harness-setup-posture.ts';
import { effectOutput, requireConfirmedAction } from './agent-harness-tool-utils.ts';
import { confirmParameter, requestParameter } from '@goodvibes-jev/engine/terminal-shell/agent-turn/effect-admission';
import { readFlag, readString } from '@goodvibes-jev/engine/terminal-shell/agent-turn/tool-args';

type AgentSetupAction =
  | 'status'
  | 'item'
  | 'repair'
  | 'token'
  | 'smoke'
  | 'finish'
  | 'import_settings'
  | 'apply_import';

interface AgentSetupToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly setupItemId?: unknown;
  readonly itemId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly fields?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentSetupToolDeps {
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function normalizeSetupAction(value: unknown): AgentSetupAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'setup' || action === 'posture' || action === 'status' || action === 'summary' || action === 'list') return 'status';
  if (action === 'item' || action === 'show' || action === 'inspect') return 'item';
  if (action === 'repair' || action === 'fix' || action === 'diagnose_repair' || action === 'host_repair' || action === 'repair_host' || action === 'launch_host') return 'repair';
  if (action === 'token' || action === 'auth' || action === 'provision_token' || action === 'repair_token') return 'token';
  if (action === 'smoke' || action === 'run_smoke' || action === 'install_smoke') return 'smoke';
  if (action === 'finish' || action === 'closeout' || action === 'apply_close' || action === 'apply_and_close') return 'finish';
  if (action === 'import' || action === 'apply_import' || action === 'import_apply') return 'apply_import';
  if (action === 'import_settings' || action === 'settings_import') return 'import_settings';
  return null;
}

const SETUP_ACTION_WORDS = ['status', 'item', 'repair', 'token', 'smoke', 'finish', 'import_settings', 'import', 'apply_import'] as const;

/**
 * The action, inferred from the fields only when none was named. A word that was
 * sent but is not an action gives null: falling back to `status` would answer a
 * different request than the one made.
 */
function readAction(args: AgentSetupToolArgs): AgentSetupAction | null {
  if (readString(args.action) || readString(args.mode)) return normalizeSetupAction(args.action) ?? normalizeSetupAction(args.mode);
  if (readString(args.setupItemId) || readString(args.itemId)) return 'item';
  return 'status';
}

function itemLookup(args: AgentSetupToolArgs): string {
  return readString(args.setupItemId) || readString(args.itemId);
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function setupStatusArgs(args: AgentSetupToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'setup_posture',
    query: args.query,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function setupItemArgs(args: AgentSetupToolArgs): Record<string, unknown> {
  const setupItemId = itemLookup(args);
  return compactArgs({
    mode: 'setup_item',
    setupItemId,
    target: setupItemId ? undefined : args.target,
    query: setupItemId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

function confirmedArgs(args: AgentSetupToolArgs): Record<string, unknown> {
  return compactArgs({
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

export function createAgentSetupTool(deps: AgentSetupToolDeps): Tool {
  return {
    definition: {
      name: 'setup',
      activity: { doing: 'Checking', did: 'checked', object: 'setup' },
      description: 'Inspect and complete first-run Agent setup.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...SETUP_ACTION_WORDS],
            description: 'Setup action; status/item read (status lists the /setup topics a person sets things up with). import_settings previews the shared-settings import; import (or apply_import) applies it. Effects need a current recorded admission.',
          },
          setupItemId: { type: 'string', description: 'Setup item id.' },
          itemId: { type: 'string', description: 'Alias for setupItemId.' },
          target: { type: 'string', description: 'Setup item lookup text.' },
          query: { type: 'string', description: 'Filter setup status or lookup a setup item.' },
          fields: { type: 'object', description: 'Optional user-run setup smoke output.' },
          includeParameters: { type: 'boolean', description: 'Include bounded route details and parameters where supported.' },
          limit: { type: 'number', description: 'Optional status list limit.' },
          confirm: confirmParameter('Only import_settings reads it, as a legacy way to ask for apply (use apply_import).'),
          explicitUserRequest: requestParameter(),
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown, options) => {
      if (!assertCurrentToolInvocation(rawArgs as Record<string, unknown>, options)) return error('Setup requires a current recorded invocation.');
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentSetupToolArgs;
      const action = readAction(args);
      if (!action) return error(`Unknown setup action "${readString(args.action) || readString(args.mode)}". Use one of: ${SETUP_ACTION_WORDS.join(', ')}.`);
      const run = (name: string, input: Record<string, unknown>) => deps.toolRegistry.executeNested(randomUUID(), name, input, options);

      if (action === 'status') return run('agent_harness', setupStatusArgs(args));
      if (action === 'item') return run('agent_harness', setupItemArgs(args));
      if (action === 'repair') {
        return run('agent_harness', compactArgs({
          mode: 'setup_repair',
          setupItemId: itemLookup(args) || undefined,
          target: itemLookup(args) ? undefined : args.target,
          query: itemLookup(args) ? undefined : args.query,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'token') {
        return run('agent_harness', {
          mode: 'provision_connected_host_token',
          setupItemId: itemLookup(args) || 'connected-host-auth',
          ...confirmedArgs(args),
        });
      }
      // Without fields nothing is run or saved: the smoke checklist is the read-only setup item.
      if (action === 'smoke' && args.fields === undefined) {
        return run('agent_harness', setupItemArgs({ ...args, setupItemId: itemLookup(args) || 'install-smoke' }));
      }
      if (action === 'smoke') {
        const setupItemId = itemLookup(args) || 'install-smoke';
        if (setupItemId !== 'install-smoke') return error('setup action:"smoke" supports setupItemId:"install-smoke" only.');
        // This call saves the evidence itself, from its own one capture of the pasted text; it is a local write.
        const refusal = requireConfirmedAction(rawArgs as Record<string, unknown>, options, 'Save setup evidence');
        if (refusal) return error(refusal);
        const ownership = resolveSetupSmokeNativeEvidence(rawArgs as Record<string, unknown>, options);
        const result = await runSetupInstallSmoke(deps.commandContext, compactArgs({
          setupItemId, includeParameters: args.includeParameters, explicitUserRequest: args.explicitUserRequest,
        }), ownership, options?.signal);
        ownership.assertCurrent();
        // The evidence snapshot is the effect: a blocked plan is still a saved result (done says whether it was saved).
        return effectOutput(result);
      }
      if (action === 'finish') {
        return run('agent_harness', {
          mode: 'run_workspace_action',
          actionId: 'onboarding-apply-close',
          ...confirmedArgs(args),
        });
      }
      if (action === 'import_settings' || action === 'apply_import') {
        return run('import_goodvibes_settings', {
          action: action === 'apply_import' || readFlag(args.confirm, 'confirm', false) ? 'apply' : 'preview',
          ...confirmedArgs(args),
        });
      }

      return error(`Unknown setup action. Use one of: ${SETUP_ACTION_WORDS.join(', ')}.`);
    },
  };
}

export function registerAgentSetupTool(
  registry: ToolRegistry,
  _commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('setup')) registry.register(createAgentSetupTool({ commandContext, toolRegistry: registry }), {
    inputProjection: {
      captureNativeReferences: createSetupSmokeReferenceCapture(commandContext, args => readAction(args) === 'smoke'
        && args.fields !== undefined && (itemLookup(args) || 'install-smoke') === 'install-smoke'),
      async project(request) { request.assertCurrent(); return { status: 'projected', args: request.args }; },
    },
  });
}
