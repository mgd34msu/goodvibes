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
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CAPABILITY_RUN_METHOD_ID, CAPABILITY_RUN_TOOL as CAPABILITY_RUN_TOOL_NAME, CapabilityRefusal, SESSION_CAPABILITIES, capabilityFindDefinition, capabilityOutcomeText, capabilityRunDefinition,
  checkCapabilityInputs, createSecretInputProjector, daemonCapability, findCapabilities, methodBodyOf, methodCapability, operatorInputFromValues, pathInputsRefusal, revealSecretInputs,
  hiddenSecret, type CapabilityCatalog, type CapabilityDefinition, type CapabilityEntry, type ClearServices, type CompactServices, type KeysCapabilityServices, type UndoServices,
  type SessionsCapabilityServices, type ConversationControlServices,
  type CodeCapabilityServices,
  type ChecklistCapabilityServices, type TasksCapabilityServices, type WorkIntakeCapabilityServices,
  type DecisionsCapabilityServices, nameCapabilityValuesWith, presentCapabilityRunAsks,
  type HooksReloadServices, type ToolRegistryCapabilityServices, type McpSessionServices, type PluginsSessionServices, type MarketplaceRecommendServices,
  type ToolsExtrasSessionServices,
  type PermissionsSessionServices, type PlanModeSessionServices, type SecretsSessionServices, type SandboxSessionServices,
  type SecurityHereServices,
  type MemorySessionCapabilityServices, type TemplateSessionCapabilityServices, type DeepLinkCapabilityServices,
  type ReplayCapabilityServices,
  type AgentsCapabilityServices,
  type EvalCapabilityServices,
  type ResearchConversationServices,
  type SystemSessionServices,
  type RoutineStartServices,
  type PinnedLinesServices,
  type ServiceSessionServices,
  type DevicesSessionServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { dropNestedSecretInputs, holdNestedSecretInputs, type SecretInputLeaf } from './operator-input-projector.js';
import type { Tool, ToolExecuteOptions } from '@goodvibes/engine/platform/platform/types';
import { assertCurrentToolInvocation, currentToolExecuteOptions, noteCurrentToolEffectSent, previewRegisteredTool, runRegisteredTool, type ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { programCallHeadersFor } from '@goodvibes/engine/platform/platform/runtime/client';
import type { ConnectedHostConfigReader } from './connected-host-client.js';
import type { AgentInProcessHost } from './in-process-host.js';
import { registerAgentOperatorMethodTool } from './operator-method-tool.js';
import { operatorContractMethods, operatorMethodIsReadOnly, ownerOnlyOperatorMethodIds, resolveOperatorContractMethod } from './operator-contract-routes.js';
import { hasDecidedAct, inRecordOfDecidedCall, noteDecidedAct, RECORD_NOT_SAVED } from './record-of-decided-call.js';
import { connectionIsThisMachine } from './knowledge-runtime.js';
import { carriedPartBody, carryFilesHere, partIdOf } from '../bundle-file-work.js';
import { PLACE_PATH_CAPABILITIES, runHoldingPaths } from '@goodvibes/engine/platform/platform/capabilities';
import { captureOperatorConnection } from './operator-connection-owner.js';
import { agentCallConnection } from './agent-call-credential.js';
import { forgetDelegatedCredential } from './agent-delegation-credential.js';
import { createDaemonRemoteTool } from './daemon-remote-tool.js';
import { declaredMethodRisk, NATIVELY_ADMITTED_METHOD_IDS, RUNS_LATER_METHOD_IDS, type MethodRisk } from '@goodvibes/engine/platform/platform/control-plane';
import { onRunAnswererChanged, runHoldsForOwner } from '@goodvibes/engine/platform/platform/permissions';
import { listedTitle } from '../places/place-titles.js';

/** The live conversation's services, from the program holding it, and its key table (builtin/keys.ts). */
export type SessionCapabilityServices = ClearServices & CompactServices & UndoServices & KeysCapabilityServices
  // Its saved sessions and branches, and the hosted session it joined (builtin/sessions.ts).
  & SessionsCapabilityServices
  // The controls on the conversation itself: the turn, its record, its context, the composer, checkpoints (builtin/conversation-controls.ts).
  & ConversationControlServices
  // The project's files: git, the code index, code lookups, tests, worktrees (builtin/code.ts).
  & CodeCapabilityServices
  // The project's checklist, the shared file this program reads (builtin/checklist.ts).
  & ChecklistCapabilityServices
  // This program's tasks and the daemon's (builtin/tasks.ts).
  & TasksCapabilityServices
  // Asking for work, and its journal (builtin/work-intake.ts).
  & WorkIntakeCapabilityServices
  // A choice on a call Jev decided here (builtin/waiting.ts).
  & DecisionsCapabilityServices
  // This program's own dispatcher, which reads the hooks file again (builtin/hooks.ts), and its tools (builtin/tools.ts).
  & HooksReloadServices & ToolRegistryCapabilityServices
  // Its own tool server connections and its session's settings for them (builtin/mcp.ts).
  & McpSessionServices
  // The plugins it runs (builtin/plugins.ts).
  & PluginsSessionServices
  // What the marketplace has that fits this project, as this program reads it (builtin/marketplace.ts).
  & MarketplaceRecommendServices
  // The terminal app's helper interfaces, its view links saved to a file, the tool in its hosted session (builtin/tools-extras.ts).
  & ToolsExtrasSessionServices
  // Permissions and safety: this conversation's permissions and plan mode, a secret for this session, its sandbox sessions.
  & PermissionsSessionServices & PlanModeSessionServices & SecretsSessionServices & SandboxSessionServices
  // Permissions and safety: what needs attention and risky MCP routes from this program's live state, the probe here (builtin/security-review.ts).
  & SecurityHereServices
  // Memory and knowledge: what this program's turns were given and holds, memory files in its project, templates as the
  // next message, links to its views (builtin/memory-session.ts, templates.ts, deeplink.ts).
  & MemorySessionCapabilityServices & TemplateSessionCapabilityServices & DeepLinkCapabilityServices
  // Work and agents: the runs this program recorded of its turns (builtin/replay.ts).
  & ReplayCapabilityServices
  // Work and agents: team modes, recipes, archetypes and work contracts of this program's own agents (builtin/agents.ts).
  & AgentsCapabilityServices
  // Work and agents: task suites run in this program's project, and a question or page sent to its conversation (builtin/eval.ts, research.ts).
  & EvalCapabilityServices & ResearchConversationServices
  // System: this session at a glance, closing the program, how much it prints (builtin/system-session.ts).
  & SystemSessionServices
  // Memory and knowledge: a routine started in this conversation (builtin/routines.ts); a model reads its steps as the answer.
  & RoutineStartServices
  // This conversation: the lines pinned in it (builtin/pinned-lines.ts).
  & PinnedLinesServices
  // Models and providers: this program's own sign-in to a daemon or listener (builtin/service-sessions.ts); the Agent keeps none.
  & ServiceSessionServices
  // Devices and network: pairing on this program's screen, and its own credential for its daemon (builtin/devices-session.ts).
  & DevicesSessionServices;

export interface CapabilityToolOptions {
  /** This program's catalog: its own described actions and the moved capabilities. */
  readonly catalog: () => CapabilityCatalog;
  /** The live conversation, once the program has one; absent in a turn with no conversation of a terminal program. */
  readonly session?: (() => SessionCapabilityServices | undefined) | undefined;
  /** Which terminal program this is, for a capability that acts on the caller's own store. */
  readonly program?: 'tui' | 'agent' | undefined;
  /** The turn's working directory (the project a hooks file or a project secret belongs to). */
  readonly workingDirectory: () => string;
  /** The model this conversation uses (provider:model), for a capability on it (its context window size). */
  readonly model?: (() => string | undefined) | undefined;
  /**
   * The conversation this turn belongs to: sent with every daemon capability the model runs, so what it adds (a
   * memory record) names the session it came from, as a person's press in that conversation does.
   */
  readonly sessionId?: (() => string | undefined) | undefined;
  /** Called with a listener the catalog's owner calls when the catalog changes (the program bound its commands). */
  readonly onCatalogChange?: ((listener: () => void) => void) | undefined;
  /**
   * Ask the person for a value on the program's hidden line: what they typed, null when they went back, undefined when
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
  let held: { readonly catalog: CapabilityCatalog; readonly holds: boolean; readonly definition: ReturnType<typeof capabilityRunDefinition> } | undefined;
  return () => {
    const current = catalog();
    const holds = runHoldsForOwner();
    if (held?.catalog === current && held.holds === holds) return held.definition;
    const entries = current.list();
    // In a run nobody answers, an action whose own method the daemon admits by asking the owner is decided as this
    // call (its own risk, under the mode): one the owner must decide is then held for them through the daemon's
    // capabilities.run (native/headless-held-calls.ts), never sent on to wait at the daemon.
    // A method that makes something run by itself later, or spends money, is decided HERE, by this program's gate, as the
    // daemon's own turns decide it (tools/capability/daemon-tools.ts): only this program sees what its conversation read
    // from outside, and after such a read the gate asks before it in every mode (security/conversation-exposure.ts,
    // permissions/manager.ts `callFacts`). Routed on, the daemon would decide it by its class alone, never asking. Every
    // other class of such a method is declared here too, so nothing the daemon would have decided is lost.
    const decidedHere = (methodId: string): boolean => RUNS_LATER_METHOD_IDS.has(methodId) || declaredMethodRisk(methodId, 'read') === 'spends-money';
    const routedThere = (methodId: string): boolean => !(holds && NATIVELY_ADMITTED_METHOD_IDS.has(methodId)) && !decidedHere(methodId);
    const here = operatorContractMethods().map((method) => method.id).filter(decidedHere);
    const ofRisk = (...risks: readonly MethodRisk[]): string[] => here.filter((methodId) => risks.includes(declaredMethodRisk(methodId, 'read') ?? 'none'));
    const definition = capabilityRunDefinition(entries, {
      // Refused here at once; what else the owner decides about a method (cannot be undone, changes a contract, a new
      // recipient) is decided at the nested call with the method's own declarations.
      ownerActs: ownerOnlyOperatorMethodIds(),
      runsLater: here.filter((methodId) => RUNS_LATER_METHOD_IDS.has(methodId)),
      sendsOrSpends: ofRisk('spends-money'),
      irreversible: ofRisk('cannot-be-undone'),
      loosens: ofRisk('loosens-a-protection', 'writes-a-secret'),
      // A daemon method named by id (or reached through an action's own method) is decided once, as the nested
      // daemon-method call it becomes; this call only routes it there.
      routed: [
        ...operatorContractMethods().map((method) => method.id).filter((methodId) => !methodId.startsWith('capabilities.') && routedThere(methodId)),
        ...entries.filter((entry) => entry.method && !daemonCapability(entry.id) && routedThere(entry.method.id)).map((entry) => entry.id),
      ],
    });
    held = { catalog: current, holds, definition };
    return definition;
  };
}

/** Whether the daemon this program reaches is on another machine (not a loopback address, not the daemon hosting this turn). */
function daemonOnAnotherMachine(host: RunHost): boolean {
  try {
    const connection = captureOperatorConnection(host.shellPaths, host.configManager, () => {}, host.inProcess);
    return !connectionIsThisMachine(connection);
  } catch {
    return false;
  }
}

/** The conversation's model for a daemon capability's call, when the program gave a way to read it. */
function modelNow(options: Pick<CapabilityToolOptions, 'model'>): { readonly model?: string } {
  try {
    const model = options.model?.();
    return model ? { model } : {};
  } catch {
    return {};
  }
}

/** The conversation's session for a daemon capability's call, when the program gave a way to read it. */
function sessionNow(options: Pick<CapabilityToolOptions, 'sessionId'>): { readonly sessionId?: string } {
  try {
    const sessionId = options.sessionId?.()?.trim();
    return sessionId ? { sessionId } : {};
  } catch {
    return {};
  }
}

/**
 * The mark the daemon reads, only from the Agent's credential, as "the program's capability gate decided this
 * `capabilities.run` call by the capability's own risk" (daemon-api control-routes.ts `CAPABILITY_GATE_DECIDED_HEADER`).
 */
const CAPABILITY_GATE_DECIDED_HEADER = 'x-goodvibes-decided-by-capability-gate';

/**
 * Where `capability_run`'s run of a daemon capability leaves the daemon's whole answer for a turn tool that ran it
 * nested (`daemonCapabilityRunner`): its data, which the model's tool result does not carry.
 */
const nestedAnswers = new AsyncLocalStorage<{ body?: Record<string, unknown> }>();

/** What one direct daemon method call answered. */
type Posted = { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly error: string };

/**
 * One daemon method call made directly, with the credential the one rule names for it (agent-call-credential.ts):
 * `capabilities.run` with the Agent's delegated credential (the host judges it as the Agent's after this gate), a
 * read such as an action's preview with the ordinary one.
 */
function daemonPoster(host: RunHost): (methodId: string, input: Record<string, unknown>, signal: AbortSignal | undefined, what: string, gateDecided?: true) => Promise<Posted> {
  return async (methodId, input, signal, what, gateDecided) => {
    let sending = false;
    try {
      const ordinary = captureOperatorConnection(host.shellPaths, host.configManager, () => signal?.throwIfAborted(), host.inProcess);
      if (!ordinary.token) return { ok: false, error: `auth_required: ${ordinary.unavailable?.reason ?? 'no daemon credential was found'}; nothing was sent.` };
      // Sent with the credential the one rule names for it (a model's call: its delegated credential).
      const { connection, delegated } = await agentCallConnection(ordinary, methodId, 'agent', host.shellPaths.homeDirectory, signal);
      // A daemon on another machine: a file or folder the call names by path is this machine's, read here and sent, and
      // what the run makes there is written back here (bundle-file-work.ts `carryFilesHere`).
      let carry: Awaited<ReturnType<typeof carryFilesHere>>;
      if (methodId === 'capabilities.run' && !connectionIsThisMachine(connection)) {
        // A part of a large file goes ahead with the same credential, as one artifact made for the call.
        const upload = async (bytes: Buffer, name: string): Promise<string> => {
          const stored = await (connection.fetch ?? fetch)(`${connection.baseUrl}/api/control-plane/methods/artifacts.create/invoke`, {
            method: 'POST', redirect: 'error', ...(signal ? { signal } : {}),
            headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ body: await carriedPartBody(bytes, name) }),
          });
          const answer = record(await stored.json().catch(() => null));
          if (!stored.ok) throw new Error(`A part of the file could not be sent ahead: ${typeof answer.error === 'string' ? answer.error : `the daemon answered ${stored.status}`}.`);
          return partIdOf(answer);
        };
        try { carry = await carryFilesHere(input, host.shellPaths.workingDirectory, upload); } catch (error) {
          return { ok: false, error: `${error instanceof Error ? error.message : String(error)} Nothing was sent.` };
        }
      }
      // The program's call context and the registration this daemon issued it for this credential: the conversation a
      // record says it came from is believed only from the program that registered it.
      const callHeaders = await programCallHeadersFor(connection.baseUrl, connection.token, connection.fetch ?? fetch);
      sending = true;
      const response = await (connection.fetch ?? fetch)(`${connection.baseUrl}/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`, {
        method: 'POST', redirect: 'error', ...(signal ? { signal } : {}),
        headers: { ...callHeaders, authorization: `Bearer ${connection.token}`, 'content-type': 'application/json',
          // Only `capability_run`'s own run, after this program's gate judged the capability, says the gate decided it.
          ...(gateDecided === true && delegated ? { [CAPABILITY_GATE_DECIDED_HEADER]: 'true' } : {}) },
        body: JSON.stringify({ body: carry?.body ?? input }),
      });
      if (response.status === 401 && delegated) await forgetDelegatedCredential(delegated).catch(() => {});
      const body = record(await response.json().catch(() => null));
      if (!response.ok) {
        const next = Array.isArray(body.next) && typeof body.next[0] === 'string' ? ` ${body.next[0]}` : '';
        return { ok: false, error: `${typeof body.error === 'string' ? body.error : `The daemon answered ${response.status}.`}${next}` };
      }
      if (carry) {
        try { carry.after(body); } catch (error) {
          return { ok: false, error: `It ran on the daemon, but what it made could not be written on this computer: ${error instanceof Error ? error.message : String(error)}.` };
        }
        const data = record(body.data);
        if (data.carried !== undefined) { const { carried: _carried, ...rest } = data; return { ok: true, body: { ...body, data: rest } }; }
      }
      return { ok: true, body };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return { ok: false, error: sending
        ? `outcome_unknown: ${what} was sent to the daemon and no answer came back (${cause}); read the current state before trying again.`
        : `connected_host_unavailable: ${what} was not sent (${cause}).` };
    }
  };
}

/**
 * The one line a call naming a capability method itself is refused with: a capability is run by its own id, and a
 * capability call is never wrapped in a method call, where it would be judged as that method instead of as itself.
 */
function capabilityMethodRefusal(id: string): string {
  return id === 'capabilities.run' || id === 'capabilities.find'
    ? `${id} is not run through capability_run: a capability is run by its own id (capability_find gives it), and a capability call is never wrapped in a method call to be judged another way.`
    : `${id} is what this tool calls: name the capability itself (capability_find gives its id), not ${id}.`;
}

/**
 * The bodies an action's preview read before the gate decided its call, kept for that call's run: the run sends the
 * body read then, as the daemon sends the one it read before asking the owner. Each is taken once; a few are kept.
 */
function previewBodies(): { keep(id: string, values: Readonly<Record<string, string>>, body: Record<string, unknown>): void; take(id: string, values: Readonly<Record<string, string>>): Record<string, unknown> | undefined } {
  const kept = new Map<string, Record<string, unknown>>();
  const key = (id: string, values: Readonly<Record<string, string>>): string => `${id}\u0000${JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))}`;
  return {
    keep(id, values, body) {
      kept.set(key(id, values), body);
      // A call the gate refused never takes its body: the oldest goes once more than a few wait.
      while (kept.size > 16) kept.delete(kept.keys().next().value!);
    },
    take(id, values) {
      const at = key(id, values);
      const body = kept.get(at);
      kept.delete(at);
      return body;
    },
  };
}

/**
 * What a capability that runs a daemon method answers in this program's own turn: the capability's own words for what
 * ran and how it came out (builtin/method-capability.ts `said` and `did`, with its done line), then the method's answer
 * as its data, the shape the daemon's `capabilities.run` gives a daemon-hosted turn. The nested method call's output
 * is its facts as JSON (`body` the answer); one that cannot be read is handed on as it came.
 */
function methodCapabilityAnswer(entry: CapabilityEntry, values: Readonly<Record<string, string>>, output: string): string {
  let facts: Record<string, unknown>;
  try { facts = record(JSON.parse(output)); } catch { return output; }
  if (!('body' in facts)) return output;
  const body = facts.body;
  const data = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : { result: body };
  const definition = methodCapability(entry.id);
  let said = '';
  try { said = definition?.said?.(data, values) ?? ''; } catch { said = ''; }
  let did: string | undefined;
  try { did = definition?.did?.(data, values); } catch { did = undefined; }
  const text = capabilityOutcomeText(entry, values, { text: said, ...(did !== undefined ? { riskDone: did } : {}) }) || `${entry.label}: done.`;
  return `${text}\n\nData: ${JSON.stringify(data, null, 2)}`;
}

function createRunTool(registry: ToolRegistry, options: CapabilityToolOptions, host: RunHost): Tool {
  const definitionNow = runDefinitionFor(options.catalog);
  const postToDaemon = daemonPoster(host);
  const runOnDaemon =async (input: Record<string, unknown>, executeOptions: Parameters<Tool['execute']>[1]): Promise<Settled> => {
    // This call was admitted by this program's gate as this capability (by its own risk and effects): it says so.
    const sent = await postToDaemon(CAPABILITY_RUN_METHOD_ID, input, executeOptions?.signal, String(input.id), true);
    if (!sent.ok) return { success: false, error: sent.error };
    const sink = nestedAnswers.getStore();
    if (sink) sink.body = sent.body;
    return { success: true, output: typeof sent.body.text === 'string' && sent.body.text ? sent.body.text : `${String(input.id)}: done.` };
  };
  // An action's preview: the daemon reads the values into the method's body, or refuses what will not run.
  const readPreview = (entry: CapabilityEntry, values: Readonly<Record<string, string>>, signal: AbortSignal | undefined): Promise<Record<string, unknown>> =>
    methodBodyOf(entry.method!, values, async (previewId, fields) => {
      const read = await postToDaemon(previewId, fields, signal, previewId);
      if (!read.ok) throw new CapabilityRefusal(`Nothing was kept: ${read.error}`);
      return read.body;
    });
  const previews = previewBodies();
  const tool: Tool = {
    definition: definitionNow(),
    // In the daemon's order: what refuses the call without the owner (its id, its inputs, its preview) is read before
    // this program's gate decides it, so nobody is asked about a call that then fails for a reason known now.
    async refuseBeforeGate(args, { signal }) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return 'id is required: a capability id from capability_find, or a daemon method id.';
      if (id.startsWith('capabilities.')) return capabilityMethodRefusal(id);
      const entry = options.catalog().get(id);
      if (!entry) return resolveOperatorContractMethod(id) ? undefined : `No capability or daemon method named ${id}. capability_find says what each capability is called.`;
      if (entry.home === 'terminal') return `${entry.id} (/${entry.command}${entry.word ? ` ${entry.word}` : ''}) has not moved to a capability that can be run from here yet; only the person can run it, from that slash command.`;
      // A secret input arrives hidden here, and one left out is typed by the person once the call is decided: neither
      // is judged by its value now.
      const given: Record<string, unknown> = { ...record(args.inputs) };
      const secret = entry.inputs.filter((input) => input.kind === 'secret');
      for (const input of secret) if (input.required === true && (typeof given[input.id] !== 'string' || given[input.id] === '')) given[input.id] = '(typed by the person)';
      const checked = checkCapabilityInputs(entry, given);
      if (!checked.ok) return checked.problem;
      // Its preview check (a file outside the project named by the model; an act on the live conversation, which cannot
      // run inside the model's own turn): refused before this program's gate asks anyone.
      const moved = entry.home === 'daemon' ? daemonCapability(entry.id) : entry.home === 'session' ? sessionDefinition(entry.id) : undefined;
      // A daemon on another machine: a file the model names in this program's project is read here and carried with the
      // call (bundle-file-work.ts `carryFilesHere`), so it is checked here as this machine's file; only a path naming a
      // place the daemon keeps using (never carried) is refused before anyone is asked, as that daemon would refuse it.
      const modelCaller = { workingDirectory: options.workingDirectory(), ...(options.program ? { program: options.program } : {}), personAsked: false,
        ...(entry.home === 'daemon' && daemonOnAnotherMachine(host) && PLACE_PATH_CAPABILITIES.has(entry.id) ? { elsewhere: true } : {}) };
      // Every file named by path is inside the project (capabilities/path-inputs.ts), then the capability's own check.
      const previewRefusal = pathInputsRefusal(entry, checked.values, modelCaller) ?? moved?.check?.(checked.values, modelCaller);
      if (previewRefusal) return previewRefusal.next ? `${previewRefusal.message} ${previewRefusal.next}.` : previewRefusal.message;
      if (entry.home !== 'daemon' || daemonCapability(entry.id) || !entry.method?.preview || secret.length > 0) return undefined;
      try {
        previews.keep(entry.id, checked.values, await readPreview(entry, checked.values, signal));
      } catch (error) {
        if (error instanceof CapabilityRefusal) return error.next ? `${error.message} ${error.next}.` : error.message;
        throw error;
      }
      return undefined;
    },
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
      if (id.startsWith('capabilities.')) return { success: false, error: capabilityMethodRefusal(id) };
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
          return { success: false, error: `Nothing was done: ${entry.id} needs ${input.label.toLowerCase()}${named}, which the person types, and there is no screen here to ask on. ${entry.ownerOnly?.instead ?? 'Ask the person to do it themselves, from its place in the menu.'}` };
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
        if (capability.available && !capability.available(live)) return { success: false, error: `${entry.label} is not something this program does; nothing was done.` };
        // The model's own turn is running while it calls this: what a capability refuses during a turn, it refuses here.
        // A routine the model starts is read as its answer, never sent as the owner's next message (builtin/routines.ts).
        const session: SessionCapabilityServices = { ...live, conversation: { ...live.conversation, isGenerating: () => true }, send: undefined };
        try {
          // Every file it names by path is held from its check to its use, for the whole run (capabilities/held-paths.ts).
          const result = await runHoldingPaths(() => capability.run(values, session, { workingDirectory: options.workingDirectory(), ...(options.program ? { program: options.program } : {}) }));
          // A run that says nothing on a typed line (a /clear, a quit) tells a model what it did in its own sentence.
          return { success: true, output: capabilityOutcomeText(entry, values, result) || capability.doneInPlace || `${entry.label}: done.` };
        } catch (error) {
          if (error instanceof CapabilityRefusal) return { success: false, error: error.next ? `${error.message} ${error.next}.` : error.message };
          // A program's own refusal (nothing to compact, a turn still running): its words are the answer.
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (entry.home === 'terminal') {
        return { success: false, error: `${entry.id} (/${entry.command}${entry.word ? ` ${entry.word}` : ''}) has not moved to a capability that can be run from here yet; only the person can run it, from that slash command.` };
      }
      // The decided act is sent now (a daemon capability): its decision is checked whole here, and what the act itself
      // changes (an import that changes permission settings) is its effect, never a change underneath this decision.
      if (daemonCapability(entry.id)) noteCurrentToolEffectSent(args, executeOptions);
      const result: Settled = daemonCapability(entry.id)
        ? await runOnDaemon({ id: entry.id, inputs: values, workingDirectory: options.workingDirectory(), ...(options.program ? { program: options.program } : {}), ...modelNow(options), ...sessionNow(options) }, executeOptions)
        : entry.method
          ? await (async () => {
            const method = entry.method!;
            if (method.preview) {
              // The action's preview reads the values into the method's body first (a read, covered by this call's
              // own admission as one that only routes); that body is the one method call decided below. It was read
              // before the gate (refuseBeforeGate) and is used as read then, as the daemon uses its own.
              let body: Record<string, unknown>;
              try {
                body = previews.take(entry.id, values) ?? await readPreview(entry, values, executeOptions?.signal);
              } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
              }
              return nested(method.id, body);
            }
            const { shown, leaves } = methodInputWithSecretsHidden(entry, values);
            return nested(method.id, shown, {}, leaves);
          })()
          : { success: false, error: `${entry.id} has no way to run from here.` };
      // A capability run through its own method answers as the daemon's capabilities.run does: its sentence, then its data.
      const output = result.success && result.output !== undefined && entry.method && !daemonCapability(entry.id)
        ? methodCapabilityAnswer(entry, values, result.output) : result.output;
      return { success: result.success, ...(output !== undefined ? { output } : {}), ...(result.error !== undefined ? { error: result.error } : {}) };
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
  // A headless run that nobody answers changes what this call decides itself (runDefinitionFor): built again then.
  onRunAnswererChanged(() => {
    const current = live.deref();
    if (current) current.definition = definitionNow();
  });
  return tool;
}

/** The one capability a record of a decided act is written with: a save into the daemon's artifact store. */
const RECORD_CAPABILITY = 'artifacts.save';

/** Whether a daemon capability (or a method named by id) acts, rather than only reads. */
function capabilityActs(id: string): boolean {
  const definition = daemonCapability(id);
  if (definition) return definition.touches !== 'reads';
  const method = resolveOperatorContractMethod(id);
  return method !== null && !operatorMethodIsReadOnly(method);
}

/** What a daemon capability answered when a turn tool ran it: the text a person reads and the facts a script reads. */
export type DaemonCapabilityAnswer =
  | { readonly ok: true; readonly text: string; readonly data: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string };

/**
 * A daemon capability (or daemon method) run for a turn tool: `options` is the executing tool call's, when the caller
 * holds it. A capability's inputs are text; a method's are its own input.
 */
export type DaemonCapabilityRun = (id: string, inputs: Readonly<Record<string, unknown>>, options?: ToolExecuteOptions) => Promise<DaemonCapabilityAnswer>;

/**
 * Run one daemon capability from a turn tool (`agent_local_registry`, `agent_documents`, `remote`, the knowledge tools,
 * an artifact save): as a nested `capability_run` call of the tool call executing now, so it goes through the one gate
 * a model's capability call is judged by (the capability's own risk and effects: a delete that cannot be undone is
 * asked as `capability_run` asks it), and only that gate's run says to the daemon that it decided the call. The
 * wrapping tool's own call only routes it there and is classed a read by its definition: one question, the
 * capability's. Outside an admitted tool call nothing is sent, unless `outside` names how the program reaches its
 * daemon (an artifact save made by the program's own flow, which only a model's tool runs: no typed line or press saves
 * an artifact in the program): such a save (a turn's work outside a tool call) is sent with no mark, and the daemon
 * decides it under the owner's mode as any outside caller's. A write made this
 * way is the daemon's, so every program's lists follow it (the capability announces its change).
 */
export function daemonCapabilityRunner(outside?: { readonly shellPaths: ShellPathService; readonly configManager: ConnectedHostConfigReader; readonly program: 'tui' | 'agent' }): DaemonCapabilityRun {
  const post = outside ? daemonPoster({ shellPaths: outside.shellPaths, configManager: outside.configManager }) : undefined;
  const answerOf = (sent: Posted, id: string): DaemonCapabilityAnswer => {
    if (!sent.ok) return { ok: false, error: sent.error };
    const text = typeof sent.body.text === 'string' ? sent.body.text : '';
    if (sent.body.ok === false) return { ok: false, error: text || `${id} was not done.` };
    return { ok: true, text, data: record(sent.body.data) };
  };
  return async (id, inputs, options) => {
    const executing = options ?? currentToolExecuteOptions();
    // The record of an act this same tool call performed (the receipt written after a calendar event was made): part of
    // the act the gate decided, made inside that call, never a question of its own (record-of-decided-call.ts). It is
    // sent as that gate's decision, with no second question; a save outside such a record is decided as its own act.
    if (id === RECORD_CAPABILITY && post && outside && inRecordOfDecidedCall() && hasDecidedAct(executing)) {
      executing!.signal?.throwIfAborted();
      // It skips the question, never a refusing rule or plan mode: a deny or never-run rule on saves, or plan mode,
      // keeps the record unsaved (the act it records already ran, and is reported as done).
      const now = await previewRegisteredTool(CAPABILITY_RUN_TOOL_NAME, { id, inputs: { ...inputs } }, executing);
      if (now === undefined) return { ok: false, error: `${RECORD_NOT_SAVED}: the program's gate could not be read for it` };
      if (now.decided.kind === 'fact' && !now.decided.allow) {
        return { ok: false, error: `${RECORD_NOT_SAVED} because ${now.mode === 'plan' ? 'plan mode is on' : `a rule of yours refuses saves${now.decided.decision.limit ? ` (${now.decided.decision.limit})` : ''}`}` };
      }
      return answerOf(await post(CAPABILITY_RUN_METHOD_ID, { id, inputs, workingDirectory: outside.shellPaths.workingDirectory, program: outside.program }, executing!.signal, id, true), id);
    }
    const sink: { body?: Record<string, unknown> } = {};
    let ran: Awaited<ReturnType<typeof runRegisteredTool>>;
    try {
      ran = executing
        ? await nestedAnswers.run(sink, () => runRegisteredTool(crypto.randomUUID(), CAPABILITY_RUN_TOOL_NAME, { id, inputs: { ...inputs } }, executing))
        : undefined;
    } catch (error) {
      // The tool call it was made for has ended (work it started goes on after it returned): not that call's any more.
      if (!post || !(error instanceof Error) || error.name !== 'ToolInputProjectionError') throw error;
      ran = undefined;
    }
    if (ran === undefined && post && outside) {
      return answerOf(await post(CAPABILITY_RUN_METHOD_ID, { id, inputs, workingDirectory: outside.shellPaths.workingDirectory, program: outside.program }, options?.signal, id), id);
    }
    if (ran === undefined) {
      return { ok: false, error: `${id} was not run: a turn tool runs a capability only inside a tool call this program's gate admitted, as capability_run. Nothing was sent.` };
    }
    if (!ran.success) return { ok: false, error: ran.error ?? `${id} was not done.` };
    // An act (not a read) admitted and run in this tool call: what the call records of it afterwards is part of it.
    if (executing && capabilityActs(id)) noteDecidedAct(executing);
    const body = sink.body ?? {};
    const text = typeof body.text === 'string' ? body.text : typeof ran.output === 'string' ? ran.output : '';
    return { ok: true, text, data: record(body.data) };
  };
}

/** What a daemon method run nested answered: its body as the method tool reported it, or why it did not run. */
export type DaemonMethodAnswer = { readonly ok: true; readonly body: unknown; readonly text: string } | { readonly ok: false; readonly error: string };

/**
 * Run one daemon method from a turn tool (`agent_operator_action`, `agent_operator_briefing`, the `google` tool's
 * calendar): as a nested `capability_run` call naming the method id, which routes it to the daemon-method runner
 * judged by the method's own declarations (an answer to an approval stays refused to a model; a delete that cannot be
 * undone is asked). The wrapping tool's own call only routes it and is classed a read. Outside an admitted tool call
 * nothing is sent.
 */
export async function runDaemonMethodNested(methodId: string, input: Readonly<Record<string, unknown>>, options: ToolExecuteOptions | undefined): Promise<DaemonMethodAnswer> {
  const executing = options ?? currentToolExecuteOptions();
  const ran = executing ? await runRegisteredTool(crypto.randomUUID(), CAPABILITY_RUN_TOOL_NAME, { id: methodId, inputs: { ...input } }, executing) : undefined;
  if (ran === undefined) return { ok: false, error: `${methodId} was not run: a turn tool runs a daemon method only inside a tool call this program's gate admitted, as capability_run. Nothing was sent.` };
  // A method that acts (not a read), admitted and sent in this tool call (it ran, or no answer came back after it was
  // sent): what the call records of it afterwards is part of that act (record-of-decided-call.ts).
  const method = resolveOperatorContractMethod(methodId);
  if (executing && method && !operatorMethodIsReadOnly(method, input) && (ran.success || ran.error?.startsWith('outcome_unknown') === true)) noteDecidedAct(executing);
  if (!ran.success) return { ok: false, error: ran.error ?? `${methodId} was not done.` };
  const text = typeof ran.output === 'string' ? ran.output : '';
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { ok: true, body: record(parsed).body, text };
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
  // The owner's ask for a capability_run call reads as the capability's own words, never its arguments as JSON.
  // A daemon method named by its id is asked in the words every method a model reaches is asked in (its title, its inputs).
  presentCapabilityRunAsks((id) => options.catalog().get(id), (method) => resolveOperatorContractMethod(method)?.title);
  // A saved session the call names is shown by its title, never its id; any other thing (a piece of work) by the title
  // a place or a form of this program last showed for it (places/place-titles.ts).
  nameCapabilityValuesWith((list, value) => list.startsWith('sessions.') ? options.session?.()?.sessions?.titleOf?.(value) : listedTitle(list, value));
  registry.register(createFindTool(options));
  // In a program's own process the remote runners are the daemon's: the `remote` tool runs the daemon's `remote.*`
  // capabilities in place of the program's own registry. A turn the daemon hosts keeps the daemon's registry tool.
  if (!inProcess && registry.has('remote')) {
    // Each mode runs its `remote.*` capability as a nested capability_run call: judged by that capability's own risk.
    registry.unregister('remote');
    registry.register(createDaemonRemoteTool(daemonCapabilityRunner()));
  }
  registry.register(createRunTool(registry, options, { shellPaths, configManager, ...(inProcess ? { inProcess } : {}) }), {
    inputProjection: createSecretInputProjector((id, given) => (options.catalog().get(id)?.inputs ?? [])
      .filter((input) => input.kind === 'secret' && input.plainWhen?.(given) !== true).map((input) => input.id)),
  });
}
