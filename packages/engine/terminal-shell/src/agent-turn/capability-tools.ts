/**
 * capability-tools.ts, the model's two tools for GoodVibes' own capabilities
 * in the terminal programs and in the turns the daemon hosts for them:
 *
 *  - `capability_find`: a need in words, three to five capabilities back
 *    (capabilities/find.ts over this program's catalog).
 *  - `capability_run`: one capability by id with its inputs, after the gate
 *    admitted the call under the person's mode (the tool's definition says
 *    which calls loosen a protection, cannot be undone or are the owner's own
 *    act). Where it runs is the capability's home: a conversation's one here,
 *    with this program's live conversation; a daemon one through
 *    `capabilities.run`, and an action with its own daemon method through that
 *    method, both as the nested daemon-method call (the folded
 *    `agent_operator_method`, nested only), so the Agent's credential and the
 *    effect admission are the one path they were. A daemon method id is run
 *    the same way, so everything the method tool reached is still reached.
 */
import {
  CAPABILITY_RUN_METHOD_ID, CapabilityRefusal, SESSION_CAPABILITIES, capabilityFindDefinition, capabilityOutcomeText, capabilityRunDefinition,
  checkCapabilityInputs, createSecretInputProjector, daemonCapability, findCapabilities, methodBodyOf, operatorInputFromValues, revealSecretInputs,
  hiddenSecret, type CapabilityCatalog, type CapabilityDefinition, type CapabilityEntry, type ClearServices, type CompactServices, type KeysCapabilityServices, type UndoServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { dropNestedSecretInputs, holdNestedSecretInputs, type SecretInputLeaf } from './operator-input-projector.js';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { assertCurrentToolInvocation, type ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { ConnectedHostConfigReader } from './connected-host-client.js';
import type { AgentInProcessHost } from './in-process-host.js';
import { registerAgentOperatorMethodTool } from './operator-method-tool.js';
import { operatorContractMethods, ownerOnlyOperatorMethodIds, resolveOperatorContractMethod } from './operator-contract-routes.js';
import { captureOperatorConnection } from './operator-connection-owner.js';
import { agentCallConnection } from './agent-call-credential.js';
import { forgetDelegatedCredential } from './agent-delegation-credential.js';

/** The live conversation's services, from the program holding it, and its key table (builtin/keys.ts). */
export type SessionCapabilityServices = ClearServices & CompactServices & UndoServices & KeysCapabilityServices;

export interface CapabilityToolOptions {
  /** This program's catalog: its own described actions and the moved capabilities. */
  readonly catalog: () => CapabilityCatalog;
  /** The live conversation, once the program has one; absent in a turn with no conversation of a terminal program. */
  readonly session?: (() => SessionCapabilityServices | undefined) | undefined;
  /** Which terminal program this is, for a capability that acts on the caller's own store. */
  readonly program?: 'tui' | 'agent' | undefined;
  /** The turn's working directory (the project a hooks file or a project secret belongs to). */
  readonly workingDirectory: () => string;
  /** Called with a listener the catalog's owner calls when the catalog changes (the program bound its commands). */
  readonly onCatalogChange?: ((listener: () => void) => void) | undefined;
  /**
   * Ask the person for a value on the program's hidden line: what he typed, null when he went back, undefined when
   * there is no screen to ask on. A secret input the model left out is asked for here, so its value never passes
   * through the model.
   */
  readonly askHidden?: ((label: string) => Promise<string | null> | undefined) | undefined;
}

const NESTED_METHOD_TOOL = 'agent_operator_method';

/** A tool call's outcome as this tool hands it on. */
interface Settled { readonly success: boolean; readonly output?: string | undefined; readonly error?: string | undefined }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function createFindTool(options: CapabilityToolOptions): Tool {
  return {
    definition: capabilityFindDefinition(),
    async execute(args, executeOptions) {
      const need = typeof args.need === 'string' ? args.need.trim() : '';
      if (!need) return { success: false, error: 'Say what you need in words: need is required.' };
      try {
        const found = await findCapabilities(options.catalog(), need, executeOptions?.signal ? { signal: executeOptions.signal } : {});
        assertCurrentToolInvocation(args, executeOptions);
        return { success: true, output: json(found) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/**
 * An action's method input as the nested call carries it, with every string a secret input put there hidden
 * (length only), and the values to put back into the request that exact call sends.
 */
function methodInputWithSecretsHidden(entry: CapabilityEntry, values: Readonly<Record<string, string>>): { readonly shown: Record<string, unknown>; readonly leaves: readonly SecretInputLeaf[] } {
  const real = operatorInputFromValues(entry.method!.fields, values);
  const secret = new Set(entry.inputs.filter((input) => input.kind === 'secret').map((input) => input.id));
  const leaves: SecretInputLeaf[] = [];
  const shown = structuredClone(real);
  const hide = (node: unknown, path: readonly string[]): unknown => {
    if (typeof node === 'string') {
      const leaf = { path, shown: hiddenSecret(node), value: node };
      leaves.push(leaf);
      return leaf.shown;
    }
    if (Array.isArray(node)) return node.map((item, index) => hide(item, [...path, String(index)]));
    if (node !== null && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, hide(item, [...path, key])]));
    return node;
  };
  for (const [field, spec] of Object.entries(entry.method!.fields)) {
    if (spec.startsWith('=') || !secret.has(spec.split(':')[0]!)) continue;
    const parts = field.split('.');
    let parent: Record<string, unknown> | undefined = shown;
    for (const part of parts.slice(0, -1)) parent = parent && typeof parent[part] === 'object' && parent[part] !== null ? parent[part] as Record<string, unknown> : undefined;
    const last = parts.at(-1)!;
    if (parent && parent[last] !== undefined) parent[last] = hide(parent[last], parts);
  }
  return { shown, leaves };
}

function sessionDefinition(id: string): CapabilityDefinition<SessionCapabilityServices> | undefined {
  return SESSION_CAPABILITIES.find((moved) => moved.definition.capability.id === id)?.definition as CapabilityDefinition<SessionCapabilityServices> | undefined;
}

interface RunHost {
  readonly shellPaths: ShellPathService;
  readonly configManager: ConnectedHostConfigReader;
  readonly inProcess?: AgentInProcessHost | undefined;
}

/**
 * The tool's definition for the program's catalog now. The program binds its commands after its turn tools are
 * registered, so the definition the gate decides by is built again when the catalog changes (the same object
 * while it does not): an action reached through its own method is then known as routed from the first call.
 */
function runDefinitionFor(catalog: () => CapabilityCatalog): () => ReturnType<typeof capabilityRunDefinition> {
  let held: { readonly catalog: CapabilityCatalog; readonly definition: ReturnType<typeof capabilityRunDefinition> } | undefined;
  return () => {
    const current = catalog();
    if (held?.catalog === current) return held.definition;
    const entries = current.list();
    const definition = capabilityRunDefinition(entries, {
      // Refused here at once; what else the owner decides about a method (cannot be undone, changes a contract, a new
      // recipient) is decided at the nested call with the method's own declarations.
      ownerActs: ownerOnlyOperatorMethodIds(),
      // A daemon method named by id (or reached through an action's own method) is decided once, as the nested
      // daemon-method call it becomes; this call only routes it there.
      routed: [...operatorContractMethods().map((method) => method.id).filter((methodId) => !methodId.startsWith('capabilities.')), ...entries.filter((entry) => entry.method && !daemonCapability(entry.id)).map((entry) => entry.id)],
    });
    held = { catalog: current, definition };
    return definition;
  };
}

function createRunTool(registry: ToolRegistry, options: CapabilityToolOptions, host: RunHost): Tool {
  const definitionNow = runDefinitionFor(options.catalog);
  /**
   * One daemon method call made directly, with the credential the one rule names for it (agent-call-credential.ts):
   * `capabilities.run` with the Agent's delegated credential (the host judges it as the Agent's after this gate), a
   * read such as an action's preview with the ordinary one.
   */
  const postToDaemon = async (methodId: string, input: Record<string, unknown>, signal: AbortSignal | undefined, what: string):
    Promise<{ readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly error: string }> => {
    let sending = false;
    try {
      const ordinary = captureOperatorConnection(host.shellPaths, host.configManager, () => signal?.throwIfAborted(), host.inProcess);
      if (!ordinary.token) return { ok: false, error: `auth_required: ${ordinary.unavailable?.reason ?? 'no daemon credential was found'}; nothing was sent.` };
      const { connection, delegated } = await agentCallConnection(ordinary, methodId, 'agent', host.shellPaths.homeDirectory, signal);
      sending = true;
      const response = await (connection.fetch ?? fetch)(`${connection.baseUrl}/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`, {
        method: 'POST', redirect: 'error', ...(signal ? { signal } : {}),
        headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ body: input }),
      });
      if (response.status === 401 && delegated) await forgetDelegatedCredential(delegated).catch(() => {});
      const body = record(await response.json().catch(() => null));
      if (!response.ok) {
        const next = Array.isArray(body.next) && typeof body.next[0] === 'string' ? ` ${body.next[0]}` : '';
        return { ok: false, error: `${typeof body.error === 'string' ? body.error : `The daemon answered ${response.status}.`}${next}` };
      }
      return { ok: true, body };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return { ok: false, error: sending
        ? `outcome_unknown: ${what} was sent to the daemon and no answer came back (${cause}); read the current state before trying again.`
        : `connected_host_unavailable: ${what} was not sent (${cause}).` };
    }
  };
  const runOnDaemon = async (input: Record<string, unknown>, executeOptions: Parameters<Tool['execute']>[1]): Promise<Settled> => {
    const sent = await postToDaemon(CAPABILITY_RUN_METHOD_ID, input, executeOptions?.signal, String(input.id));
    if (!sent.ok) return { success: false, error: sent.error };
    return { success: true, output: typeof sent.body.text === 'string' && sent.body.text ? sent.body.text : `${String(input.id)}: done.` };
  };
  const tool: Tool = {
    definition: definitionNow(),
    async execute(args, executeOptions) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return { success: false, error: 'id is required: a capability id from capability_find, or a daemon method id.' };
      const nested = async (methodId: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}, secrets: readonly SecretInputLeaf[] = []) => {
        if (!executeOptions) return { success: false, error: `${id} runs only as an admitted tool call.` };
        const callId = crypto.randomUUID();
        holdNestedSecretInputs(callId, secrets);
        try {
          return await registry.executeNested(callId, NESTED_METHOD_TOOL, { methodId, input, ...extra }, executeOptions);
        } finally {
          dropNestedSecretInputs(callId);
        }
      };
      // The capability methods are this tool itself: a capability is named by its own id, so its risk is read.
      if (id.startsWith('capabilities.')) return { success: false, error: `${id} is what this tool calls: name the capability itself (capability_find gives its id), not ${id}.` };
      const entry = options.catalog().get(id);
      if (!entry) {
        // A daemon method by id, as the method tool this one replaced took it.
        const method = resolveOperatorContractMethod(id);
        if (!method) return { success: false, error: `No capability or daemon method named ${id}. capability_find says what each capability is called.` };
        const extra = Object.fromEntries(['confirm', 'explicitUserRequest', 'dryRun'].filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
        const result: Settled = await nested(method.id, record(args.inputs), extra);
        return { success: result.success, ...(result.output !== undefined ? { output: result.output } : {}), ...(result.error !== undefined ? { error: result.error } : {}) };
      }
      // A secret input reached this body hidden (secret-inputs.ts); its value is put back only here.
      const given: Record<string, unknown> = { ...revealSecretInputs(executeOptions?.inputProjectionContext, args) };
      // A secret the model named and left without its value (a key's name and no key): the person types it on the
      // hidden line, after this call was decided; the value goes to the capability and never to the model.
      for (const input of entry.inputs) {
        if (input.kind !== 'secret' || input.required !== true || (typeof given[input.id] === 'string' && given[input.id] !== '')) continue;
        const named = typeof given['key'] === 'string' && given['key'] ? ` for ${given['key']}` : '';
        const typed = options.askHidden?.(`${entry.label}: ${input.label}${named}`);
        if (typed === undefined) {
          return { success: false, error: `Nothing was done: ${entry.id} needs ${input.label.toLowerCase()}${named}, which the person types, and there is no screen here to ask on. Ask the person to run /${entry.command}${entry.word ? ` ${entry.word}` : ''} themselves.` };
        }
        const value = await typed;
        if (value === null || value === '') return { success: false, error: `Nothing was done: the person did not type ${input.label.toLowerCase()}${named}.` };
        given[input.id] = value;
      }
      const checked = checkCapabilityInputs(entry, given);
      if (!checked.ok) return { success: false, error: checked.problem };
      const values = checked.values;
      if (entry.home === 'session') {
        const live = options.session?.();
        const capability = sessionDefinition(entry.id);
        if (!live || !capability) return { success: false, error: `${entry.id} acts on a terminal program's open conversation, and this turn has none to act on.` };
        // The model's own turn is running while it calls this: what a capability refuses during a turn, it refuses here.
        const session: SessionCapabilityServices = { ...live, conversation: { ...live.conversation, isGenerating: () => true } };
        try {
          const result = await capability.run(values, session, { workingDirectory: options.workingDirectory(), ...(options.program ? { program: options.program } : {}) });
          return { success: true, output: capabilityOutcomeText(entry, values, result) || `${entry.label}: done.` };
        } catch (error) {
          if (error instanceof CapabilityRefusal) return { success: false, error: error.next ? `${error.message} ${error.next}.` : error.message };
          // A program's own refusal (nothing to compact, a turn still running): its words are the answer.
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (entry.home === 'terminal') {
        return { success: false, error: `${entry.id} (/${entry.command}${entry.word ? ` ${entry.word}` : ''}) has not moved to a capability that can be run from here yet; only the person can run it, from that slash command.` };
      }
      const result: Settled = daemonCapability(entry.id)
        ? await runOnDaemon({ id: entry.id, inputs: values, workingDirectory: options.workingDirectory(), ...(options.program ? { program: options.program } : {}) }, executeOptions)
        : entry.method
          ? await (async () => {
            const method = entry.method!;
            if (method.preview) {
              // The action's preview reads the values into the method's body first (a read, covered by this call's
              // own admission as one that only routes); that body is the one method call decided below.
              let body: Record<string, unknown>;
              try {
                body = await methodBodyOf(method, values, async (previewId, fields) => {
                  const read = await postToDaemon(previewId, fields, executeOptions?.signal, previewId);
                  if (!read.ok) throw new CapabilityRefusal(`Nothing was kept: ${read.error}`);
                  return read.body;
                });
              } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
              }
              return nested(method.id, body);
            }
            const { shown, leaves } = methodInputWithSecretsHidden(entry, values);
            return nested(method.id, shown, {}, leaves);
          })()
          : { success: false, error: `${entry.id} has no way to run from here.` };
      return { success: result.success, ...(result.output !== undefined ? { output: result.output } : {}), ...(result.error !== undefined ? { error: result.error } : {}) };
    },
  };
  // The program lends its commands after this tool exists: the definition is built again then (the registry
  // captures a replaced definition before the next call), so the gate decides by the whole catalog.
  // Held weakly: a registry that is gone (a finished worker's) keeps nothing alive here.
  const live = new WeakRef(tool);
  options.onCatalogChange?.(() => {
    const current = live.deref();
    if (current) current.definition = definitionNow();
  });
  return tool;
}

/**
 * Register `capability_find` and `capability_run`, and the daemon-method
 * runner they call nested (offered to the model no longer). `inProcess`: the
 * daemon hosting this turn (in-process-host.ts); absent in a program's own process.
 */
export function registerCapabilityTools(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: ConnectedHostConfigReader,
  options: CapabilityToolOptions,
  inProcess?: AgentInProcessHost,
): void {
  registerAgentOperatorMethodTool(registry, shellPaths, configManager, inProcess);
  registry.register(createFindTool(options));
  registry.register(createRunTool(registry, options, { shellPaths, configManager, ...(inProcess ? { inProcess } : {}) }), {
    inputProjection: createSecretInputProjector((id) => (options.catalog().get(id)?.inputs ?? []).filter((input) => input.kind === 'secret').map((input) => input.id)),
  });
}
