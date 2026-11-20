import { describeConfiguredPermissions, describePermissionMode } from '../permissions/configured-posture.ts';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { PermissionManager, createPermissionConfigReader, describePermissionModeInForce } from '@goodvibes/engine/platform/platform/permissions';
import { createRuntimeSecretsManager, resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config';
import { composeJudgment } from '@goodvibes/engine/platform/platform/runtime/operations';
import { createAsyncDisposalScope } from '@goodvibes/engine/platform/platform/runtime/disposal';
import { createShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell-paths';
import { resolveAndValidatePath, resolveWritablePath } from '@goodvibes/engine/platform/platform/utils';
import { decisionModelUse } from '@goodvibes/engine/errors';
import { JudgmentError } from '@goodvibes/judgment';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import type { PermissionCheckResult } from '@goodvibes/engine/platform/platform/permissions';
import { createFeatureFlagManager, deriveFeatureStates } from '@/runtime/index.ts';
import { createPolicyRuntimeState, createUserPermissionRuleStore } from '@goodvibes/engine/platform/platform/runtime/bootstrap';
import { getProviderIdFromModel } from '@goodvibes/engine/platform/platform/providers';
import { describeConfiguredEffort } from '../providers/reasoning-effort-surface.ts';
import type { CliCommandOutput } from '@goodvibes/engine/terminal-shell';
import type { GoodVibesCliOutputFormat } from '@goodvibes/engine/terminal-shell';
import { buildHooksValidation } from './hooks-report.ts';
import { createEditTool, createWriteTool } from '@goodvibes/engine/platform/platform/tools';
import { FileStateCache, FileUndoManager } from '@goodvibes/engine/platform/platform/state';
import type { ToolDefinition } from '@goodvibes/engine/platform/platform/types';

// ---------------------------------------------------------------------------
// `goodvibes doctor <explain|routing|hooks>`, the diagnostician subcommands.
// Each one explains a decision the platform already makes, reading the LIVE
// config and reusing the platform's OWN decision machinery. None of them
// changes config or fires a real action:
//   explain , walks the real PermissionManager to say why a tool/command
//              would be allowed / asked / denied under the current mode.
//   routing , prints which model/provider serves which role, from live config.
//   hooks   , lists registered hooks, from where, and their validation status
//              (reuses the hooks-validate core in hooks-report.ts).
// ---------------------------------------------------------------------------

export interface DoctorSubcommandOptions {
  readonly subcommand: string;
  readonly args: readonly string[];
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly outputFormat?: GoodVibesCliOutputFormat;
}

/** The tool names the platform's PermissionManager recognizes (from its TOOL_CATEGORIES/TOOL_CONFIG_KEYS). */
const KNOWN_TOOLS = new Set([
  'read', 'find', 'fetch', 'analyze', 'inspect', 'state', 'registry', 'goodvibes_context', 'repo_map',
  'write', 'edit', 'goodvibes_settings', 'exec', 'agent', 'delegate', 'workflow', 'mcp',
]);
/** Tools whose primary display/decision argument is a filesystem path rather than a command. */
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'find', 'fetch', 'analyze', 'inspect', 'state', 'registry']);

/** The permission-mode → human label map (matches the doctor/status wording). */


/**
 * Turn the `explain` argument list into the tool+args shape the
 * PermissionManager evaluates. A bare recognized tool name is taken as that
 * tool (with any remainder as its path/command arg); anything else is treated
 * as a shell command run through the `exec` tool.
 */
interface ExplainTarget {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly interpretation: string;
  /** The path the call targets, for the tool's own containment check. */
  readonly path?: string;
  /** The tool's own registration (declared effects, path arguments, undo), as the running app registers it. */
  readonly definition?: ToolDefinition;
}

/**
 * The file tools as the running app registers them (tools/index.ts: with an
 * undo manager, so a change inside the project is recoverable), and the call
 * shape each takes, so the gate reads the same declared facts it reads in the
 * app instead of an undeclared `{ path }` that only a judgment can settle.
 */
function fileToolCall(tool: string, path: string, workingDirectory: string): Pick<ExplainTarget, 'args' | 'definition'> | undefined {
  const fileUndoManager = new FileUndoManager();
  if (tool === 'write') {
    return { args: { files: [{ path, content: '' }] }, definition: createWriteTool({ projectRoot: workingDirectory, fileUndoManager }).definition };
  }
  if (tool === 'edit') {
    return { args: { edits: [{ path, find: '', replace: '' }] }, definition: createEditTool(new FileStateCache(), { cwd: workingDirectory, fileUndoManager }).definition };
  }
  return undefined;
}

function resolveExplainTarget(args: readonly string[], workingDirectory: string): ExplainTarget {
  const first = args[0] ?? '';
  if (KNOWN_TOOLS.has(first)) {
    const remainder = args.slice(1).join(' ').trim();
    if (remainder.length === 0) {
      return { tool: first, args: {}, interpretation: `recognized tool "${first}" (no target argument)` };
    }
    if (first === 'exec') {
      return { tool: 'exec', args: { command: remainder }, interpretation: `tool "exec" running command: ${remainder}` };
    }
    if (PATH_TOOLS.has(first)) {
      const call = fileToolCall(first, remainder, workingDirectory);
      return { tool: first, args: call?.args ?? { path: remainder }, ...(call?.definition ? { definition: call.definition } : {}), path: remainder, interpretation: `tool "${first}" targeting path: ${remainder}` };
    }
    return { tool: first, args: { command: remainder }, interpretation: `tool "${first}" with argument: ${remainder}` };
  }
  const command = args.join(' ').trim();
  return { tool: 'exec', args: { command }, interpretation: `shell command run through the "exec" tool: ${command}` };
}

/** Labels describe only the source the platform returned, not an invented execution trace. */
const DECISION_SOURCE_LABELS: Readonly<Record<PermissionCheckResult['sourceLayer'], string>> = {
  jev_decision: 'Recorded Jev decision',
  boundary: 'Boundary checks', stakes_preset: 'Stakes preset',
  config_policy: 'Configured permission policy', managed_policy: 'Managed runtime policy',
  safety_check: 'Safety check', runtime_mode: 'Active permission mode',
  invocation_admission: 'Current invocation admission',
  session_override: 'Remembered session decision', user_rule: 'Durable owner rule',
  user_prompt: 'Human approval prompt (Human-in-the-Loop)',
};

function decidedLayerLabel(result: PermissionCheckResult, autoApprove: boolean): string {
  if (result.sourceLayer === 'config_policy' && result.reasonCode === 'config_allow' && autoApprove) {
    return 'Automatic approval after boundary checks';
  }
  return DECISION_SOURCE_LABELS[result.sourceLayer] ?? 'Unknown permission source';
}

/** The authoritative ALLOW / ASK / DENY verdict from a PermissionManager result. */
function verdictOf(result: PermissionCheckResult): 'ALLOW' | 'ASK' | 'DENY' {
  if (result.sourceLayer === 'user_prompt') return 'ASK';
  return result.approved ? 'ALLOW' : 'DENY';
}

/** A plain-language "because" line keyed off the platform's own reasonCode. */
function reasonExplanation(result: PermissionCheckResult, mode: string, autoApprove: boolean, toolKey: string): string {
  if (result.detail) return result.detail;
  switch (result.reasonCode) {
    case 'config_allow':
      if (autoApprove) return 'Auto-approve is active (behavior.autoApprove); this call passed the boundary and was allowed without a prompt.';
      if (mode === 'custom') return `The per-tool rule permissions.tools.${toolKey} is set to "allow".`;
      return 'The configured permission policy allowed this call after boundary checks.';
    case 'config_deny': return `The per-tool rule permissions.tools.${toolKey} is set to "deny".`;
    case 'preset_allow':
    case 'preset_deny':
      return result.preset && result.reading
        ? `The ${result.preset.preset} preset returned "${result.preset.action}" for this call's ${result.reading.stakes} stakes reading.`
        : `The stakes preset ${result.approved ? 'allowed' : 'denied'} this call.`;
    case 'mode_allow_all': return 'The configured permission mode allowed this call.';
    case 'invocation_already_admitted': return 'This exact executing invocation already has a current admission; no new permission decision was needed.';
    case 'mode_denied': return 'The active permission mode denies this tool class.';
    case 'plan_mode': return 'The plan preset refused this call because it changes state or reaches outside the machine.';
    case 'managed_policy_allow': return 'A runtime policy rule allowed this call.';
    case 'managed_policy_deny': return 'A runtime policy rule denied this call.';
    case 'safety_guardrail': return 'A safety guardrail blocked this call.';
    case 'session_cached_allow': return 'A remembered session decision ([A] allow-always) approves this call.';
    case 'session_cached_deny': return 'A remembered session decision denies this call.';
    case 'user_rule_allow': return 'A durable owner rule allowed this call.';
    case 'user_rule_deny': return 'A durable owner rule denied this call.';
    case 'owner_approved_outward': return 'The owner approved this outward call.';
    case 'boundary_judgment_input':
    case 'boundary_catastrophic':
    case 'boundary_surface_authority':
    case 'boundary_card_details':
    case 'boundary_outward_effect': return `The boundary refused this call (${result.boundary?.refusedBy ?? result.reasonCode}).`;
    case 'owner_act': return 'Only the owner does this himself; a model\'s call of it is refused in every mode.';
    case 'user_approved':
    case 'user_denied': return 'This reaches a Human-in-the-Loop approval prompt; the outcome depends on your response at the prompt.';
    default: return 'Decided by the platform permission machinery.';
  }
}

/** Stable per-tool config key for the explain narrative (mirrors the platform's TOOL_CONFIG_KEYS defaults). */
function toolConfigKey(tool: string): string {
  const map: Record<string, string> = {
    goodvibes_context: 'state', goodvibes_settings: 'write', repo_map: 'read',
  };
  return map[tool] ?? tool;
}

/** The tools that read paths and refuse one outside the project root in every mode but yolo (tools/index.ts). */
const CONTAINED_READ_TOOLS = new Set(['read', 'find', 'inspect', 'repo_map', 'analyze']);
/** The tools that change files and refuse a path outside the project root in every mode. */
const CONTAINED_WRITE_TOOLS = new Set(['write', 'edit']);

/**
 * What the tool itself does with the call's path after the gate allowed it:
 * read tools refuse a path outside the project root unless the mode in force
 * is yolo, and write tools refuse one in every mode. Undefined when the tool
 * has no path or keeps it.
 */
function containmentRefusal(tool: string, path: string | undefined, workingDirectory: string, mode: string): string | undefined {
  if (path === undefined || path.length === 0) return undefined;
  try {
    if (CONTAINED_WRITE_TOOLS.has(tool)) resolveWritablePath(path, workingDirectory);
    else if (CONTAINED_READ_TOOLS.has(tool)) resolveAndValidatePath(path, workingDirectory, mode === 'yolo');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function explain(options: DoctorSubcommandOptions): Promise<CliCommandOutput> {
  const json = options.outputFormat === 'json';
  const { args } = options;
  if (args.length === 0) {
    return { output: 'Usage: goodvibes doctor explain <tool-name | shell command>', exitCode: 2 };
  }
  const config = options.configManager;
  const target = resolveExplainTarget(args, options.workingDirectory);
  const savedMode = String(config.get('permissions.mode') ?? 'ask-me');
  const autoApprove = config.get('behavior.autoApprove') === true;
  const inForce = describePermissionModeInForce(config);

  // The gate the running app uses: its feature flags and managed policy from live config, the
  // owner's remembered rules, and the decision model with its decision log in this user's home.
  // An ask goes nowhere: the handler answers "no" without prompting, and the result is reported
  // as ASK. Nothing is remembered, run or changed. A judgment it needs is a real request to the
  // decision model, bounded by judgment.decisionDeadlineMs like any permission decision.
  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({ flags: deriveFeatureStates(config) });
  const policyEngineOn = featureFlags.isEnabled('permissions-policy-engine');
  const policyRuntimeState = createPolicyRuntimeState(config, featureFlags);
  const shellPaths = createShellPathService({ workingDirectory: options.workingDirectory, homeDirectory: options.homeDirectory });
  const scope = createAsyncDisposalScope('doctor explain');
  const controller = new AbortController();
  let result: PermissionCheckResult;
  let category: string;
  let settledBy: 'fact' | 'owner-only' | 'judgment';
  let rulesNote: string | undefined;
  try {
    const secretsManager = createRuntimeSecretsManager({
      projectRoot: options.workingDirectory,
      globalHome: options.homeDirectory,
      surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
      configManager: config,
      daemonHome: resolveGoodVibesDaemonHome(options.homeDirectory),
    });
    composeJudgment({
      config,
      secrets: secretsManager,
      env: process.env,
      stateRoot: shellPaths.resolveUserPath(GOODVIBES_TUI_SURFACE_ROOT),
      disposal: scope.registry,
    });
    const ruleStore = createUserPermissionRuleStore(config);
    let rules: typeof ruleStore | null = ruleStore;
    try { await ruleStore.awaitReady(); }
    catch (error) {
      // The running app refuses every call while the rules file cannot be read; say so.
      rules = null;
      rulesNote = `remembered rules could not be read (${error instanceof Error ? error.message : String(error)}); the running app refuses tool calls until the file loads`;
    }
    const manager = new PermissionManager(
      async () => ({ approved: false, remember: false }),
      createPermissionConfigReader(config),
      policyRuntimeState,
      null,
      featureFlags,
      rules,
    );
    category = manager.getCategory(target.tool, target.args, target.definition);
    // Whether this call is one the decision model is asked about at all (no request: the classifier only).
    settledBy = (await manager.previewDecision(target.tool, target.args, target.definition, controller.signal)).decided.kind;
    try {
      result = await manager.checkDetailed(target.tool, target.args, undefined, { signal: controller.signal, ...(target.definition ? { definition: target.definition } : {}) });
    } catch (error) {
      // Under Decision Model Only a decision the model could not answer stops the call: say so instead of a stack.
      if (!(error instanceof JudgmentError)) throw error;
      const stopped = `not consulted: ${error.message} judgment.policy is Decision Model Only, so the call stops with this reason and nothing is asked.`;
      if (json) {
        return { output: JSON.stringify({ subject: args.join(' '), tool: target.tool, category, args: target.args, mode: inForce.mode, savedMode,
          ...(inForce.reason !== undefined ? { modeReason: inForce.reason } : {}), decisionModel: stopped, decisionModelConsulted: false,
          verdict: 'DENY', because: error.message }, null, 2), exitCode: 0 };
      }
      return { output: [
        'GoodVibes doctor: explain permission decision',
        `  subject     : ${args.join(' ')}`,
        `  resolved as : ${target.interpretation}`,
        `  mode        : ${inForce.mode} (${describePermissionMode(inForce.mode).label}) in force${inForce.mode === inForce.chosen ? '' : `; set: ${savedMode}`}`,
        `  decision model: ${stopped}`,
        '',
        'Decision: DENY',
        `  because    : ${error.message}`,
      ].join('\n'), exitCode: 0 };
    }
  } finally {
    controller.abort();
    await scope.close();
  }
  const containment = result.approved ? containmentRefusal(target.tool, target.path, options.workingDirectory, inForce.mode) : undefined;
  const verdict = containment !== undefined ? 'DENY' : verdictOf(result);
  const decidedLayer = containment !== undefined ? `The ${target.tool} tool (path containment)` : decidedLayerLabel(result, autoApprove);
  const toolKey = toolConfigKey(target.tool);
  const because = containment !== undefined
    ? `${containment}. The gate allowed the call; the ${target.tool} tool refuses a path outside the project root${CONTAINED_WRITE_TOOLS.has(target.tool) ? ' in every mode' : ' in every mode except yolo'}.`
    : reasonExplanation(result, inForce.mode, autoApprove, toolKey);
  // Whether the decision model was asked: a fact or an owner-only item never asks it; a judgment call
  // decided without one says why (none set, No Decision Model, or the set model failing).
  const withoutModel = result.decisionPolicy?.operation === 'no-decision-model' ? decisionModelUse(result.decisionPolicy).line : undefined;
  const consulted = settledBy === 'judgment' && withoutModel === undefined;
  const decisionModel = settledBy === 'fact' ? 'not needed: a rule, a setting or the mode settled this call'
    : settledBy === 'owner-only' ? 'not needed: only you decide this call'
      : withoutModel !== undefined ? `not consulted: ${withoutModel} The verdict is the one the gate gives without a decision model.`
        : 'consulted';

  if (json) {
    return {
      output: JSON.stringify({
        subject: args.join(' '),
        tool: target.tool,
        category,
        args: target.args,
        mode: inForce.mode,
        savedMode,
        ...(inForce.reason !== undefined ? { modeReason: inForce.reason } : {}),
        autoApprove,
        configuredPosture: describeConfiguredPermissions(config),
        permissionEvaluated: true,
        policyEngine: policyEngineOn ? 'enabled' : 'disabled',
        decisionModel,
        decisionModelConsulted: consulted,
        ...(rulesNote !== undefined ? { rememberedRules: rulesNote } : {}),
        ...(containment !== undefined ? { containment } : {}),
        verdict,
        decidedLayer,
        sourceLayer: result.sourceLayer,
        reasonCode: result.reasonCode,
        because,
        analysis: result.analysis,
      }, null, 2),
      exitCode: 0,
    };
  }

  const a = result.analysis;
  const lines: string[] = [
    'GoodVibes doctor: explain permission decision',
    `  subject     : ${args.join(' ')}`,
    `  resolved as : ${target.interpretation}`,
    `  tool        : ${target.tool}  (category: ${category})`,
    `  args         : ${JSON.stringify(target.args)}`,
    '',
    'Current settings:',
    `  mode        : ${inForce.mode} (${describePermissionMode(inForce.mode).label}) in force${inForce.mode === inForce.chosen ? '' : `; set: ${savedMode}`}`,
    ...(inForce.reason !== undefined ? [`                not ${inForce.chosen}, because ${inForce.reason}`] : []),
    `  autoApprove : ${autoApprove ? 'yes (behavior.autoApprove)' : 'no'}`,
    `  posture     : ${describeConfiguredPermissions(config).detail}`,
    `  policyEngine: ${policyEngineOn ? 'enabled' : 'disabled'} (permissions.engine)`,
    `  rules       : ${rulesNote ?? 'the remembered rules of this project were read'}`,
    `  decision model: ${decisionModel}`,
    '',
    'Analysis (from the platform analyzer):',
    `  risk        : ${a.riskLevel.toUpperCase()} (${a.classification})`,
    ...(a.surface || a.blastRadius ? [`  surface     : ${a.surface ?? 'generic'}${a.blastRadius ? `  radius=${a.blastRadius}` : ''}`] : []),
    `  summary     : ${a.summary}`,
    ...a.reasons.slice(0, 3).map((r) => `  reason      : ${r}`),
    '',
    'Reported gate facts (not an inferred execution trace):',
    ...(result.boundary ? [`  boundary    : ${result.boundary.passed ? 'passed' : `not passed (${result.boundary.refusedBy ?? 'unspecified'})`}`] : []),
    ...(result.reading ? [`  stakes      : ${result.reading.stakes}`] : []),
    ...(result.preset ? [`  preset      : ${result.preset.preset} -> ${result.preset.action}`] : []),
    `  gate        : ${result.approved ? 'allowed' : verdictOf(result) === 'ASK' ? 'asks the owner' : 'refused'} (${result.sourceLayer}/${result.reasonCode})`,
    ...(containment !== undefined ? [`  tool        : refused (${containment})`] : []),
    `  source      : ${decidedLayer}   ← DECIDED HERE`,
    '',
    `Decision: ${verdict}`,
    `  decided by : ${containment !== undefined ? `${target.tool} tool path containment` : `${result.sourceLayer} (${result.reasonCode})`}`,
    `  because    : ${because}`,
  ];
  return { output: lines.join('\n'), exitCode: 0 };
}

/** One routed role: which provider+model the live config assigns to it, and the keys that carry it. */
interface RoutingRole {
  readonly role: string;
  readonly enabled: boolean | null;
  readonly provider: string;
  readonly model: string;
  readonly keys: readonly string[];
  readonly note?: string;
}

function buildRoutingRoles(config: ConfigManager): RoutingRole[] {
  const mainModel = String(config.get('provider.model') ?? '');
  const mainProvider = getProviderIdFromModel(mainModel);
  const emptyProvider = (p: string): string => (p.length > 0 ? p : `(inherits main: ${mainProvider})`);

  const toolProvider = String(config.get('tools.llmProvider') ?? '');
  const toolModel = String(config.get('tools.llmModel') ?? '');
  const helperProvider = String(config.get('helper.globalProvider') ?? '');
  const helperModel = String(config.get('helper.globalModel') ?? '');
  const ttsProvider = String(config.get('tts.llmProvider') ?? '');
  const ttsModel = String(config.get('tts.llmModel') ?? '');

  return [
    {
      role: 'Conversation (main model)',
      enabled: null,
      provider: mainProvider,
      model: mainModel || '(unset)',
      keys: ['provider.model', 'provider.reasoningEffort'],
      // Both halves: the level that is configured, and what that level
      // actually becomes on this model. They differ whenever the model does
      // not offer the configured level, and a doctor report that printed only
      // the first would hide exactly the mismatch it exists to find.
      note: `reasoningEffort=${String(config.get('provider.reasoningEffort') ?? '')}`
        + ` -> ${describeConfiguredEffort(mainModel, String(config.get('provider.reasoningEffort') ?? ''))}`,
    },
    {
      role: 'Embeddings',
      enabled: null,
      provider: String(config.get('provider.embeddingProvider') ?? '') || `(inherits main: ${mainProvider})`,
      model: '(provider default)',
      keys: ['provider.embeddingProvider'],
    },
    {
      role: 'Tool LLM (grunt tool work)',
      enabled: config.get('tools.llmEnabled') === true,
      provider: emptyProvider(toolProvider),
      model: toolModel || '(unset)',
      keys: ['tools.llmEnabled', 'tools.llmProvider', 'tools.llmModel'],
      ...(config.get('tools.llmEnabled') === true ? {} : { note: 'disabled: no tool-LLM route active' }),
    },
    {
      role: 'Helper (supporting work: resume summaries)',
      enabled: config.get('helper.enabled') === true,
      provider: emptyProvider(helperProvider),
      model: helperModel || `(inherits main: ${mainModel || 'unset'})`,
      keys: ['helper.enabled', 'helper.globalProvider', 'helper.globalModel'],
      ...(config.get('helper.enabled') === true ? {} : { note: 'disabled: supporting work stays on the main model' }),
    },
    {
      role: 'Narration LLM (TTS phrasing)',
      enabled: null,
      provider: emptyProvider(ttsProvider),
      model: ttsModel || '(unset)',
      keys: ['tts.llmProvider', 'tts.llmModel'],
      note: `engine=${String(config.get('tts.provider') ?? '(unset)')}`,
    },
  ];
}

function routing(options: DoctorSubcommandOptions): CliCommandOutput {
  const config = options.configManager;
  const roles = buildRoutingRoles(config);
  if (options.outputFormat === 'json') {
    return { output: JSON.stringify({ roles }, null, 2), exitCode: 0 };
  }
  const lines: string[] = [
    'GoodVibes doctor: model / provider routing (live config)',
    '',
  ];
  for (const role of roles) {
    const state = role.enabled === null ? '' : role.enabled ? ' [on]' : ' [off]';
    lines.push(`  ${role.role}${state}`);
    lines.push(`    provider : ${role.provider}`);
    lines.push(`    model    : ${role.model}`);
    if (role.note) lines.push(`    note     : ${role.note}`);
    lines.push(`    from     : ${role.keys.join(', ')}`);
    lines.push('');
  }
  return { output: lines.join('\n').replace(/\n+$/, ''), exitCode: 0 };
}

function hooks(options: DoctorSubcommandOptions): CliCommandOutput {
  const report = buildHooksValidation(options.configManager);
  if (options.outputFormat === 'json') {
    return {
      output: JSON.stringify({
        path: report.path,
        present: report.present,
        valid: report.valid,
        reason: report.reason ?? null,
        topLevelIssues: report.topLevelIssues,
        hooks: report.checks.map((c) => ({ pattern: c.pattern, index: c.index, name: c.name, type: c.type, source: report.path, ok: c.ok, reason: c.reason ?? null, contract: c.contract ? { authority: c.contract.authority, executionMode: c.contract.executionMode } : null })),
        chains: report.chains,
      }, null, 2),
      exitCode: report.valid ? 0 : 1,
    };
  }

  const lines: string[] = [
    'GoodVibes doctor: registered hooks',
    `  source file : ${report.path}`,
  ];
  if (!report.present) {
    lines.push('  no hooks file present: nothing registered.');
    return { output: lines.join('\n'), exitCode: 0 };
  }
  if (report.reason && report.checks.length === 0 && report.topLevelIssues.length === 0) {
    lines.push(`  FAIL: ${report.reason}`);
    return { output: lines.join('\n'), exitCode: 1 };
  }
  lines.push(`  registered  : ${report.checks.length} hook(s), ${report.chains.accepted} chain(s) accepted`);
  lines.push(`  validation  : ${report.passCount} pass, ${report.failCount} problem(s)`);
  lines.push('');
  for (const issue of report.topLevelIssues) lines.push(`  FAIL (file): ${issue}`);
  for (const check of report.checks) {
    const status = check.ok ? 'PASS' : 'FAIL';
    lines.push(`  [${status}] ${check.pattern} #${check.index} ${check.name} (type: ${check.type})`);
    lines.push(`         from: ${report.path}`);
    if (check.ok && check.contract) {
      lines.push(`         contract: ${check.contract.authority}/${check.contract.executionMode} (deny=${check.contract.canDeny ? 'yes' : 'no'})`);
    } else if (!check.ok) {
      lines.push(`         reason: ${check.reason}`);
    }
  }
  if (report.chains.declared > 0 || report.chains.accepted > 0) {
    lines.push('');
    lines.push(`  chains: ${report.chains.declared} declared, ${report.chains.accepted} accepted by the loader`);
  }
  lines.push('');
  lines.push(report.valid ? '  result: all registered hooks are valid.' : `  result: ${report.failCount} problem(s) found.`);
  return { output: lines.join('\n'), exitCode: report.valid ? 0 : 1 };
}

/** Route a `doctor <sub>` invocation. Returns null when <sub> is not a doctor subcommand (caller renders the classic doctor report). */
export async function handleDoctorSubcommand(options: DoctorSubcommandOptions): Promise<CliCommandOutput | null> {
  switch (options.subcommand) {
    case 'explain': return explain(options);
    case 'routing': return routing(options);
    case 'hooks': return hooks(options);
    default: return null;
  }
}
