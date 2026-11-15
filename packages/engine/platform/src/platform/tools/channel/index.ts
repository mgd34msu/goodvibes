import type { Tool } from '../../types/tools.js';
import type { ChannelPluginRegistry } from '../../channels/index.js';
import type { ChannelAccountLifecycleAction, ChannelConversationKind } from '../../channels/index.js';

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Account actions that write or remove credentials, and operator actions that
 * change who may talk to the agent. Their arguments carry secrets or widen
 * access, so the owner runs them from the operator surface; a call made by the
 * model is refused whatever approval the generic tool prompt gave it.
 */
const OWNER_ONLY_ACCOUNT_ACTIONS: ReadonlySet<string> = new Set(['setup', 'login', 'logout']);
const OWNER_ONLY_OPERATOR_ACTIONS: ReadonlySet<string> = new Set(['edit-allowlist']);

function ownerOnly(what: string, surface: string): { success: false; error: string } {
  return invalid(`${what} on '${surface}' changes credentials or access, so this tool does not run it. Nothing was changed. Ask the owner to run it from the operator surface (the daemon channel routes or the terminal channel commands).`);
}

function invalid(message: string): { success: false; error: string } {
  return { success: false, error: message };
}

export function createChannelTool(registry: ChannelPluginRegistry | null): Tool {
  return {
    definition: {
      name: 'channel',
      description:
        'Inspect and operate channel surfaces. '
        + 'Modes: accounts, account_action, directory, resolve_target, capabilities, tools, agent_tools, run_tool, actions, run_action, authorize. '
        + 'run_action refuses actions marked dangerous and edit-allowlist, and account_action refuses setup, login and logout; the owner runs those. '
        + 'authorize checks that the account is enabled and the action is available; actorId is the value you pass, not an identity, and is evaluated against an allowlist only when result.metadata.actorEvaluated is true.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: [
              'accounts',
              'account_action',
              'directory',
              'resolve_target',
              'capabilities',
              'tools',
              'agent_tools',
              'run_tool',
              'actions',
              'run_action',
              'authorize',
            ],
          },
          surface: { type: 'string' },
          accountId: { type: 'string' },
          accountAction: { type: 'string' },
          query: { type: 'string' },
          target: { type: 'string' },
          preferredKind: { type: 'string' },
          threadId: { type: 'string' },
          createIfMissing: { type: 'boolean' },
          live: { type: 'boolean' },
          scope: { type: 'string' },
          groupId: { type: 'string' },
          limit: { type: 'number' },
          toolId: { type: 'string' },
          actionId: { type: 'string' },
          actorId: { type: 'string' },
          input: { type: 'object' },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      sideEffects: ['state', 'network'],
      concurrency: 'serial',
    },

    async execute(args) {
      const mode = typeof args.mode === 'string' ? args.mode : '';
      const surface = typeof args.surface === 'string' ? args.surface : undefined;
      if (!registry) {
        return invalid('No active channel registry is available in this runtime.');
      }

      switch (mode) {
        case 'accounts': {
          if (surface && typeof args.accountId === 'string') {
            const account = await registry.getAccount(surface as never, args.accountId);
            return {
              success: true,
              output: formatJson({ surface, account }),
            };
          }
          const accounts = await registry.listAccounts(surface as never);
          return {
            success: true,
            output: formatJson({ surface: surface ?? null, accounts }),
          };
        }
        case 'account_action': {
          if (!surface) return invalid('account_action mode requires "surface".');
          const action = readLifecycleAction(args.accountAction ?? args.actionId);
          if (!action) return invalid('account_action mode requires a valid "accountAction".');
          if (OWNER_ONLY_ACCOUNT_ACTIONS.has(action)) return ownerOnly(`Account action '${action}'`, surface);
          const result = await registry.runAccountAction(
            surface as never,
            action,
            typeof args.accountId === 'string' ? args.accountId : undefined,
            typeof args.input === 'object' && args.input !== null ? args.input as Record<string, unknown> : undefined,
          );
          if (result === null) {
            return invalid(`Unknown channel account action '${action}' for surface '${surface}'.`);
          }
          return {
            success: true,
            output: formatJson({ surface, accountId: args.accountId ?? null, action, result }),
          };
        }
        case 'directory': {
          if (!surface) return invalid('directory mode requires "surface".');
          const entries = await registry.queryDirectory(surface as never, {
            ...(typeof args.query === 'string' ? { query: args.query } : {}),
            ...(typeof args.scope === 'string' ? { scope: args.scope as never } : {}),
            ...(typeof args.groupId === 'string' ? { groupId: args.groupId } : {}),
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
            ...(typeof args.live === 'boolean' ? { live: args.live } : {}),
          });
          return {
            success: true,
            output: formatJson({ surface, entries }),
          };
        }
        case 'resolve_target': {
          if (!surface) return invalid('resolve_target mode requires "surface".');
          const targetInput = typeof args.target === 'string'
            ? args.target
            : typeof args.query === 'string'
              ? args.query
              : typeof args.input === 'object' && args.input !== null && typeof (args.input as Record<string, unknown>).target === 'string'
                ? String((args.input as Record<string, unknown>).target)
                : '';
          if (!targetInput.trim()) return invalid('resolve_target mode requires "target" or "query".');
          const resolved = await registry.resolveTarget(surface as never, {
            input: targetInput,
            ...(typeof args.accountId === 'string' ? { accountId: args.accountId } : {}),
            ...(readConversationKind(args.preferredKind) ? { preferredKind: readConversationKind(args.preferredKind)! } : {}),
            ...(typeof args.threadId === 'string' ? { threadId: args.threadId } : {}),
            ...(typeof args.createIfMissing === 'boolean' ? { createIfMissing: args.createIfMissing } : {}),
            ...(typeof args.live === 'boolean' ? { live: args.live } : {}),
          });
          if (!resolved) {
            return invalid(`Unable to resolve channel target '${targetInput}' for surface '${surface}'.`);
          }
          return {
            success: true,
            output: formatJson({ surface, target: resolved }),
          };
        }
        case 'capabilities': {
          const capabilities = await registry.listCapabilities(surface as never);
          return {
            success: true,
            output: formatJson({ surface: surface ?? null, capabilities }),
          };
        }
        case 'tools': {
          const tools = await registry.listTools(surface as never);
          return {
            success: true,
            output: formatJson({ surface: surface ?? null, tools }),
          };
        }
        case 'agent_tools': {
          const tools = registry.listAgentTools(surface as never).map((tool) => tool.definition);
          return {
            success: true,
            output: formatJson({ surface: surface ?? null, tools }),
          };
        }
        case 'run_tool': {
          if (!surface) return invalid('run_tool mode requires "surface".');
          if (typeof args.toolId !== 'string' || args.toolId.trim().length === 0) {
            return invalid('run_tool mode requires "toolId".');
          }
          // A tool runs its first action, so a tool is held to the same owner-only rule as the
          // action it wraps: run_tool must not reach what run_action and account_action refuse.
          const described = (await registry.listTools(surface as never)).find((tool) => tool.id === args.toolId || tool.name === args.toolId);
          if (described && (described.metadata['dangerous'] === true
            || described.actionIds.some((id) => OWNER_ONLY_OPERATOR_ACTIONS.has(id) || id === 'account-action'))) {
            return invalid(`Channel tool '${args.toolId}' on '${surface}' changes credentials or access or is marked dangerous, so this tool does not run it. Nothing was changed. Ask the owner to run it from the operator surface (the daemon channel routes or the terminal channel commands).`);
          }
          const result = await registry.runTool(
            surface as never,
            args.toolId,
            typeof args.input === 'object' && args.input !== null ? args.input as Record<string, unknown> : undefined,
          );
          if (result === null) {
            return invalid(`Unknown channel tool '${args.toolId}' for surface '${surface}'.`);
          }
          return {
            success: true,
            output: formatJson({ surface, toolId: args.toolId, result }),
          };
        }
        case 'actions': {
          const actions = await registry.listOperatorActions(surface as never);
          return {
            success: true,
            output: formatJson({ surface: surface ?? null, actions }),
          };
        }
        case 'run_action': {
          if (!surface) return invalid('run_action mode requires "surface".');
          if (typeof args.actionId !== 'string' || args.actionId.trim().length === 0) {
            return invalid('run_action mode requires "actionId".');
          }
          // A confirm flag or preview id in the arguments is the model's own claim, never the owner's
          // confirmation, so an action that needs one is not run from here.
          if (OWNER_ONLY_OPERATOR_ACTIONS.has(args.actionId)) return ownerOnly(`Channel action '${args.actionId}'`, surface);
          const described = (await registry.listOperatorActions(surface as never)).find((action) => action.id === args.actionId);
          if (described?.dangerous) {
            return invalid(`Channel action '${args.actionId}' on '${surface}' is marked dangerous, so this tool does not run it: a confirmation in the tool arguments is not the owner's. Nothing was changed. Ask the owner to run it from the operator surface.`);
          }
          const result = await registry.runOperatorAction(
            surface as never,
            args.actionId,
            typeof args.input === 'object' && args.input !== null ? args.input as Record<string, unknown> : undefined,
          );
          if (result === null) {
            return invalid(`Unknown channel action '${args.actionId}' for surface '${surface}'.`);
          }
          return {
            success: true,
            output: formatJson({ surface, actionId: args.actionId, result }),
          };
        }
        case 'authorize': {
          if (!surface) return invalid('authorize mode requires "surface".');
          if (typeof args.actionId !== 'string' || args.actionId.trim().length === 0) {
            return invalid('authorize mode requires "actionId".');
          }
          const target = typeof args.target === 'string' && args.target.trim()
            ? await registry.resolveTarget(surface as never, {
                input: args.target,
                ...(typeof args.accountId === 'string' ? { accountId: args.accountId } : {}),
                // A check must not create the conversation it asks about.
                createIfMissing: false,
              })
            : null;
          const result = await registry.authorizeActorAction(surface as never, {
            actionId: args.actionId,
            ...(typeof args.actorId === 'string' ? { actorId: args.actorId } : {}),
            ...(target ? { target } : {}),
            ...(typeof args.input === 'object' && args.input !== null ? { input: args.input as Record<string, unknown> } : {}),
          });
          return {
            success: true,
            output: formatJson({ surface, actionId: args.actionId, result }),
          };
        }
        default:
          return invalid(`Unknown mode: ${mode}`);
      }
    },
  };
}

function readLifecycleAction(value: unknown): ChannelAccountLifecycleAction | null {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'inspect':
    case 'setup':
    case 'retest':
    case 'connect':
    case 'disconnect':
    case 'start':
    case 'stop':
    case 'login':
    case 'logout':
    case 'wait_login':
      return value;
    default:
      return null;
  }
}

function readConversationKind(value: unknown): ChannelConversationKind | null {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'direct':
    case 'group':
    case 'thread':
    case 'channel':
    case 'service':
      return value;
    default:
      return null;
  }
}
