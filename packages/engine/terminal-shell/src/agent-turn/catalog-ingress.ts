/**
 * catalog-ingress.ts, how a protected catalog call is admitted: the call's
 * input is screened by the research-source owner before any registry guard,
 * repair reader or log sees it (personal-ops-ingress.ts), the sources it reads
 * are checked again at every boundary, and a call one tool forwards to another
 * keeps the original call's admission. The Agent harness and the learning
 * consolidation tool admit through it, in the Agent's own process and in a
 * session the daemon hosts for the Agent.
 *
 * What only the Agent's own process has (its command context: the settings
 * it reads, the live session, a settings-import preview, channel drafts and
 * setup smoke runs a call names) comes in as a `CatalogIngressContext`; a
 * call made without one is admitted on the research owner and its own checks.
 */
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { assertCurrentToolExecution, assertCurrentToolInvocation, assertCurrentToolEffect, ToolInputProjectionError, type ToolInputProjector, type ToolRegistry, type ToolExecutionEffect } from '@goodvibes/engine/platform/platform/tools';
import { agentResearchSourceOwner } from './protected-research-report.js';
import { captureModelReadingInput, assertModelReadingInputCurrent } from './model-reading.js';
import { captureCatalogData } from './catalog-data.js';
import { createPersonalOpsInputProjector } from './personal-ops-ingress.js';
import { RetainedGuards } from './retained-guards.js';

type ToolExecuteOptions = NonNullable<Parameters<Tool['execute']>[1]>;

/** A settings-import preview read once from its native source, with the check that it is still that source. */
export interface CatalogPreviewCapture {
  readonly preview: unknown;
  readonly sourceViews: unknown;
  readonly assertCurrent: () => void;
}

/** What the Agent's own process adds to a protected catalog call's admission. */
export interface CatalogIngressContext {
  /** The command context a settings-import preview is bound to; a preview is read only for this one. */
  readonly owner?: object | undefined;
  /** Native references a call names (a channel draft, a setup smoke run), captured before projection. */
  readonly captureNativeReferences?: ToolInputProjector['captureNativeReferences'] | undefined;
  /** Whether a workspace action is a settings-import preview, inspected from its native source. */
  readonly isSettingsPreview?: ((args: Record<string, unknown>) => boolean) | undefined;
  /** Reads the settings-import preview once; absent where no command context exists. */
  readonly capturePreview?: (() => CatalogPreviewCapture) | undefined;
  /** The check over the process sources a protected call reads (settings when it inspects them, the live session, the MCP registry). */
  readonly sourceGuard?: ((settings: boolean) => () => void) | undefined;
}

const MEMORY_CATALOG_MODES = new Set(['memory_posture', 'memory_provider']);
const PRESERVED_CATALOG_MODES = new Set([...MEMORY_CATALOG_MODES, 'route_decision', 'browser_control_route', 'run_local_model_smoke', 'autonomy_intake', 'autonomy_queue', 'autonomy_queue_item', 'learning_curator', 'learning_candidate', 'background_processes', 'background_process', 'cli_commands', 'cli_command', 'shortcuts', 'keybindings', 'keybinding', 'set_keybinding', 'reset_keybinding', 'run_keybinding', 'agent_orchestration', 'agent_orchestration_agent', 'execution_posture', 'execution_route', 'execution_history', 'execution_history_item', 'document_ops_lane', 'delegation_posture', 'delegation_route']);
const CATALOG_MODES = new Set(['modes', 'mode', 'commands', 'command', 'run_command', 'tools', 'tool', 'operator_methods', 'operator_method', ...PRESERVED_CATALOG_MODES]);
const PERSONAL_OPS_MODES = new Set(['personal_ops_briefing', 'personal_ops', 'personal_ops_queue', 'personal_ops_intake', 'personal_ops_lane', 'run_personal_ops_read']);
const PROTECTED_COMMS_EFFECT_MODES = new Set(['channel_draft_save', 'channel_draft_send', 'channel_routing_assign', 'channel_routing_remove']);
const projectionGuards = new WeakMap<object, () => void>();
const publicationGuards = new WeakMap<object, RetainedGuards>();

/**
 * A translated call's authority: the original, already admitted call's checks.
 * It belongs to the call, not to an argument object: it is found through the
 * call's options (the engine's execution capability, the same object every
 * forwarded step is given), so a structural copy of the arguments keeps it and
 * nothing the model writes can mint it. Forwards nest and may overlap within
 * one call; the innermost one still running applies.
 */
interface CallAdmission {
  readonly assertCurrent: () => void;
  readonly assertInvocation: () => boolean;
  readonly assertEffect: (effect: ToolExecutionEffect) => boolean;
}
const callAdmissions = new WeakMap<ToolExecuteOptions, CallAdmission[]>();

function admissionOf(options: ToolExecuteOptions | undefined): CallAdmission | undefined {
  const active = options === undefined ? undefined : callAdmissions.get(options);
  return active?.[active.length - 1];
}
interface SettingsPreviewBinding {
  readonly owner: object;
  readonly registry: ToolRegistry;
  readonly capture: CatalogPreviewCapture;
  readonly aliases: Set<object>;
  released: boolean;
}
const settingsPreviewBindings = new WeakMap<object, SettingsPreviewBinding>();

/** The body reads the exact native source acquired by its original projection. */
export function capturedCatalogPreview(args: Record<string, unknown>, options: ToolExecuteOptions | undefined,
  owner: object, registry: ToolRegistry): CatalogPreviewCapture {
  const binding = settingsPreviewBindings.get(args);
  if (!binding || binding.released || binding.owner !== owner || binding.registry !== registry) throw new ToolInputProjectionError('stale');
  harnessCatalogExecutionGuard(args, options)(); binding.capture.assertCurrent();
  return binding.capture;
}
function retainedGuards(args: object): RetainedGuards {
  let guards = publicationGuards.get(args);
  if (!guards) { guards = new RetainedGuards(); publicationGuards.set(args, guards); }
  return guards;
}
/** Register only already-acquired backend guards; never acquire a backend here. */
export function retainHarnessCatalogCurrent(args: object): (guard: () => void, key?: string) => void {
  const guards = retainedGuards(args);
  return (guard, key) => { guards.add(guard, key); };
}

/** Only read data routing descriptors, before screening the complete original. */
export function catalogRoutingInput(input: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== 'object') throw new ToolInputProjectionError('invalid');
  const result: Record<string, unknown> = {};
  for (const key of ['mode', 'action', 'query', 'target', 'command', 'commandName', 'methodId', 'toolName', 'key', 'setting']) {
    if (Object.hasOwn(input, key)) result[key] = input[key];
  }
  return result;
}

export function isHarnessCatalogQuery(input: Record<string, unknown>): boolean {
  const routing = catalogRoutingInput(input);
  if (typeof routing.mode === 'string' && (PERSONAL_OPS_MODES.has(routing.mode) || PROTECTED_COMMS_EFFECT_MODES.has(routing.mode) || MEMORY_CATALOG_MODES.has(routing.mode))) { captureCatalogData(input); return true; }
  if (routing.mode === 'model_routing' || routing.mode === 'model_route' || routing.mode === 'local_model_cookbook') { captureCatalogData(input); return true; }
  if (typeof routing.mode === 'string' && PRESERVED_CATALOG_MODES.has(routing.mode)) captureCatalogData(input);
  // `target` names an exact id: the lookup is code (rankHarnessCatalog), so it is not screened as a phrase.
  return typeof routing.mode === 'string' && CATALOG_MODES.has(routing.mode)
    && typeof routing.query === 'string' && routing.query.trim().length > 0;
}

/** The research owner stays the one bound to the registry, and the process sources the context names stay as captured. */
function catalogContextGuard(registry: ToolRegistry, context: CatalogIngressContext | undefined, settings = false): () => void {
  const owner = agentResearchSourceOwner(registry);
  const sources = context?.sourceGuard?.(settings);
  return () => {
    sources?.();
    if (agentResearchSourceOwner(registry) !== owner) throw new ToolInputProjectionError('stale');
  };
}

/** Reuse the protected-source owner and full original invocation projector. */
export function createCatalogInputProjector(registry: ToolRegistry, fallback?: ToolInputProjector,
  selected = isHarnessCatalogQuery, context?: CatalogIngressContext): ToolInputProjector {
  const projector = createPersonalOpsInputProjector(registry, fallback, selected);
  const captureNativeReferences = context?.captureNativeReferences;
  return { ...(captureNativeReferences ? { captureNativeReferences } : {}), async project(request) {
    const protectedQuery = selected(request.args);
    const retained = retainedGuards(request.args);
    const routing = catalogRoutingInput(request.args);
    const previewInspection = routing.mode === 'run_workspace_action' && context?.isSettingsPreview?.(request.args) === true;
    const settingsInspection = request.name === 'settings' || routing.mode === 'settings' || routing.mode === 'get_setting' || previewInspection;
    const assertContext = protectedQuery ? catalogContextGuard(registry, context, settingsInspection) : () => {};
    const modelInspection = routing.mode === 'model_routing' || routing.mode === 'model_route' || routing.mode === 'local_model_cookbook' || request.name === 'models'
      || routing.mode === 'memory_posture' || routing.mode === 'memory_provider' || request.name === 'memory';
    const original = protectedQuery && (modelInspection || settingsInspection) ? captureModelReadingInput(request.args) : undefined;
    const originalJson = original && JSON.stringify(original);
    let previewBinding: SettingsPreviewBinding | undefined;
    if (protectedQuery && previewInspection) {
      const owner = context?.owner, capturePreview = context?.capturePreview;
      if (!owner || !capturePreview) throw new ToolInputProjectionError('unconfigured');
      request.assertCurrent(); request.signal?.throwIfAborted(); assertContext();
      const native = capturePreview();
      const view = captureModelReadingInput({ preview: native.preview, sources: native.sourceViews });
      native.assertCurrent(); assertContext(); request.assertCurrent(); request.signal?.throwIfAborted();
      previewBinding = { owner, registry, capture: { preview: view.preview, sourceViews: view.sources, assertCurrent: native.assertCurrent }, aliases: new Set(), released: false };
      retained.add(native.assertCurrent);
    }
    const guarded = protectedQuery ? { ...request, ...(original ? { args: original } : {}), assertCurrent: () => {
      request.assertCurrent(); assertContext();
      for (const guard of retained.values()) guard();
      if (original) assertModelReadingInputCurrent(request.args, originalJson);
    } } : request;
    const result = await projector.project(guarded);
    if (!protectedQuery || result.status !== 'projected') return result;
    publicationGuards.set(result.args, retained);
    const bindPreview = (args: object) => {
      if (previewBinding) { settingsPreviewBindings.set(args, previewBinding); previewBinding.aliases.add(args); }
    };
    bindPreview(result.args);
    let released = false;
    const assertCurrent = () => {
      if (released) throw new ToolInputProjectionError('stale');
      // The trusted selected projector already checks guarded.assertCurrent
      // before and after owner.project. Do not repeat that complete registry
      // proof a third time in this same synchronous boundary.
      if (result.assertCurrent) result.assertCurrent(); else guarded.assertCurrent();
    };
    return { ...result, ...((modelInspection || settingsInspection) ? { resultPublication: 'read-only' as const } : {}),
      assertRepairedArgs(candidate) {
        result.assertRepairedArgs?.(candidate); assertCurrent();
        // The registry supplies this exact final argument object to execute.
        // A structural copy cannot inherit a protected invocation's lifetime.
        projectionGuards.set(candidate, assertCurrent); publicationGuards.set(candidate, retained);
        bindPreview(candidate);
      },
      async release() {
        // Engine cleanup retires the one-use execution before releasing its
        // projection. Only retained source/backend facts survive that lease.
        released = true;
        if (previewBinding) previewBinding.released = true;
        try {
          await result.release?.();
          assertContext();
          if (original) assertModelReadingInputCurrent(request.args, originalJson);
          for (const guard of retained.values()) guard();
        } finally {
          if (previewBinding) for (const args of previewBinding.aliases) {
            if (settingsPreviewBindings.get(args) === previewBinding) settingsPreviewBindings.delete(args);
          }
        }
      },
    };
  } };
}

/** Verify the original invocation, including admission, after every catalog await. */
export function harnessCatalogExecutionGuard(args: Record<string, unknown>, options?: ToolExecuteOptions): () => void {
  const inherited = admissionOf(options);
  if (inherited) return inherited.assertCurrent;
  const projected = projectionGuards.get(args);
  const retained = retainedGuards(args);
  const signal = options?.signal;
  return () => {
    if (options?.signal !== signal) throw new ToolInputProjectionError('stale');
    signal?.throwIfAborted();
    assertCurrentToolExecution(args, options);
    // This private projection checks the retained source guards on both sides
    // of owner.project. No borrowed callback runs between it and this return.
    if (projected) projected();
    else for (const guard of retained.values()) guard();
  };
}

/** Trusted translations retain the original engine proof; arguments never mint it. */
export function harnessCatalogInvocationAuthority(args: Record<string, unknown>, options?: ToolExecuteOptions, effect?: ToolExecutionEffect): boolean {
  const inherited = admissionOf(options);
  if (inherited) {
    inherited.assertCurrent();
    return effect ? inherited.assertEffect(effect) : inherited.assertInvocation();
  }
  harnessCatalogExecutionGuard(args, options)();
  return effect ? assertCurrentToolEffect(args, options, effect) : assertCurrentToolInvocation(args, options);
}

/**
 * Runs a translated call under the original call's admission, found through
 * the call's options, never re-proven per argument object.
 */
export async function forwardHarnessCatalogCall(tool: Tool, original: Record<string, unknown>, forwarded: Record<string, unknown>, options?: ToolExecuteOptions,
  additionalGuard?: () => void) {
  const originalGuard = harnessCatalogExecutionGuard(original, options);
  const inherited = admissionOf(options);
  const originalInvocation = inherited ? inherited.assertInvocation : () => assertCurrentToolInvocation(original, options);
  const originalEffect = inherited ? inherited.assertEffect : (effect: ToolExecutionEffect) => assertCurrentToolEffect(original, options, effect);
  const assertCurrent = () => { originalGuard(); additionalGuard?.(); };
  assertCurrent(); publicationGuards.set(forwarded, retainedGuards(original));
  const admission: CallAdmission = {
    assertCurrent,
    assertInvocation: () => { assertCurrent(); return originalInvocation(); },
    assertEffect: (effect) => { assertCurrent(); return originalEffect(effect); },
  };
  // Without options there is no engine admission to carry: the forwarded body's
  // own checks find none, as the original call's would.
  let active: CallAdmission[] | undefined;
  if (options !== undefined) {
    active = callAdmissions.get(options);
    if (!active) { active = []; callAdmissions.set(options, active); }
    active.push(admission);
  }
  try { const result = await tool.execute(forwarded, options); assertCurrent(); return result; }
  finally {
    const index = active?.lastIndexOf(admission) ?? -1;
    if (active && index >= 0) active.splice(index, 1);
  }
}

/** Raw factory callers use the same full-source boundary as registered callers. */
export function protectCatalogTool(tool: Tool, registry: ToolRegistry, selected = isHarnessCatalogQuery, context?: CatalogIngressContext): Tool {
  const projector = createCatalogInputProjector(registry, undefined, selected, context);
  return { ...tool, async execute(input, options) {
    if (!selected(input)) return tool.execute(input, options);
    const routing = catalogRoutingInput(input);
    const previewInspection = routing.mode === 'run_workspace_action' && context?.isSettingsPreview?.(input) === true;
    if (!admissionOf(options) && !projectionGuards.has(input)) { publicationGuards.set(input, new RetainedGuards()); }
    const guard = harnessCatalogExecutionGuard(input, options);
    // The tool's registration, read once by name (no scan of every registered tool).
    const registration = registry.definitionOf(tool.definition.name);
    const assertContext = catalogContextGuard(registry, context, tool.definition.name === 'settings' || routing.mode === 'settings' || routing.mode === 'get_setting'
      || previewInspection);
    const assertRegistrationCurrent = () => {
      assertContext();
      if (registry.definitionOf(tool.definition.name) !== registration) throw new ToolInputProjectionError('stale');
    };
    const assertCurrent = () => { guard(); assertRegistrationCurrent(); };
    assertCurrent();
    if (projectionGuards.has(input)) {
      // Forwarding already invokes this exact input's execution/projection
      // guard. The additional check owns only context and registration.
      return forwardHarnessCatalogCall(tool, input, input, options, assertRegistrationCurrent);
    }
    const projected = await projector.project({ callId: 'catalog-direct', name: tool.definition.name, args: input,
      signal: options?.signal, assertCurrent });
    try {
      if (projected.status !== 'projected') throw new ToolInputProjectionError('held');
      return await forwardHarnessCatalogCall(tool, input, projected.args, options, projected.assertCurrent);
    } finally { await projected.release?.(); assertCurrent(); }
  } };
}
