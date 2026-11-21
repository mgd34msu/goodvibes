import type { Tool } from '../../types/tools.js';
import type { ChannelPluginRegistry } from '../../channels/index.js';
import type { ChannelConversationKind } from '../../channels/index.js';
import { CHANNEL_ACCOUNT_ACTION_EFFECTS, readAccountLifecycleAction } from '../../channels/builtin/account-action-effects.js';
import { describeActionFailure, outcomeOfActionResult } from '../../channels/action-outcome.js';

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Account actions that write or remove credentials (read from the effect table
 * beside the actions, whatever name an action is called by), and operator
 * actions that change who may talk to the agent. Their arguments carry secrets
 * or widen access, so the owner runs them from the operator surface; a call
 * made by the model is refused whatever approval the generic tool prompt gave it.
 */
const CREDENTIAL_ACCOUNT_ACTIONS: readonly string[] = Object.entries(CHANNEL_ACCOUNT_ACTION_EFFECTS)
  .filter(([, effect]) => effect.changesCredentials)
  .map(([action]) => action);
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
        + 'run_action refuses actions marked dangerous and edit-allowlist, and account_action refuses the actions that write or remove credentials ('
        + `${CREDENTIAL_ACCOUNT_ACTIONS.join(', ')}); the owner runs those. `
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
            description: 'What to do; see the tool description. Every mode but accounts, capabilities, tools, agent_tools and actions needs surface.',
          },
          surface: { type: 'string', description: 'The channel surface, such as slack, discord or telegram; for the listing modes, omitted means every surface.' },
          accountId: { type: 'string', description: 'The account on the surface: accounts shows that one; account_action, resolve_target and authorize act for it.' },
          accountAction: { type: 'string', description: 'account_action: the account action to run (actions that write or remove credentials are refused).' },
          query: { type: 'string', description: 'directory: the text to look up; resolve_target: the target when target is not given.' },
          target: { type: 'string', description: 'resolve_target: the user, chat or channel to resolve, as a name or id; authorize: the target the action would reach.' },
          preferredKind: { type: 'string', description: 'resolve_target: the kind of conversation to prefer: direct, group, channel, thread or service.' },
          threadId: { type: 'string', description: 'resolve_target: the thread within the target.' },
          createIfMissing: { type: 'boolean', description: 'resolve_target: when nothing matches, return the target as given instead of failing.' },
          live: { type: 'boolean', description: 'directory, resolve_target: also ask the provider, not only the routes already known.' },
          scope: { type: 'string', description: 'directory: which entries: all, self, users, peers, groups, channels, threads, services or members.' },
          groupId: { type: 'string', description: 'directory: the group whose members or threads to list.' },
          limit: { type: 'number', description: 'directory: at most this many entries.' },
          toolId: { type: 'string', description: 'run_tool: the channel tool, by id or name, as mode tools lists it.' },
          actionId: { type: 'string', description: 'run_action, authorize: the operator action, as mode actions lists it.' },
          actorId: { type: 'string', description: 'authorize: the sender to check; it is a value you pass, not a proven identity.' },
          input: { type: 'object', description: 'account_action, run_tool, run_action, authorize: the arguments the action or tool takes.' },
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
      // A surface the registry does not have, or has switched off, would read below as no accounts,
      // no entries or an unknown action; it is named here instead.
      if (surface) {
        const known = registry.describeSurface(surface);
        const enabled = known.enabled.length > 0 ? known.enabled.join(', ') : 'none';
        if (known.state === 'unknown') return invalid(`Unknown channel surface '${surface}'; enabled surfaces: ${enabled}.`);
        if (known.state === 'disabled') return invalid(`The ${surface} channel is disabled; enable it on the operator surface. Enabled surfaces: ${enabled}.`);
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
          const action = readAccountLifecycleAction(args.accountAction ?? args.actionId);
          if (!action) return invalid(`account_action mode requires a valid "accountAction", one of: ${Object.keys(CHANNEL_ACCOUNT_ACTION_EFFECTS).join(', ')}.`);
          if (CHANNEL_ACCOUNT_ACTION_EFFECTS[action].changesCredentials) return ownerOnly(`Account action '${action}'`, surface);
          const result = await registry.runAccountAction(
            surface as never,
            action,
            typeof args.accountId === 'string' ? args.accountId : undefined,
            typeof args.input === 'object' && args.input !== null ? args.input as Record<string, unknown> : undefined,
          );
          if (result === null) {
            return invalid(`Unknown channel account action '${action}' for surface '${surface}'.`);
          }
          // A result that says ok: false did not complete, as for run_tool and run_action.
          const outcome = outcomeOfActionResult(result);
          if (outcome.status !== 'ok') return invalid(describeActionFailure(outcome));
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
          const outcome = await registry.invokeTool(
            surface as never,
            args.toolId,
            typeof args.input === 'object' && args.input !== null ? args.input as Record<string, unknown> : undefined,
          );
          if (outcome.status !== 'ok') return invalid(describeActionFailure(outcome));
          return {
            success: true,
            output: formatJson({ surface, toolId: args.toolId, result: outcome.result }),
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
          const outcome = await registry.invokeOperatorAction(
            surface as never,
            args.actionId,
            typeof args.input === 'object' && args.input !== null ? args.input as Record<string, unknown> : undefined,
          );
          if (outcome.status !== 'ok') return invalid(describeActionFailure(outcome));
          return {
            success: true,
            output: formatJson({ surface, actionId: args.actionId, result: outcome.result }),
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
