import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
/**
 * Runtime permissions evaluator.
 *
 * Evaluates owner-authored and managed policy rules (and the mode layer used
 * by policy simulation) through a layered priority stack. First match wins.
 * The gate (permissions/manager.ts) consults only its rule layer.
 */

import type {
  PermissionDecision,
  PermissionMode,
  CommandClassification,
  DecisionReason,
  EvaluationStep,
  PolicyRule,
  SourceLayer,
  PermissionsConfig,
  CallSubjects,
} from './types.js';
import type { BundleProvenance } from './policy-loader.js';

import { evaluatePrefixRule } from './rules/prefix.js';
import { evaluateArgShapeRule, evaluateArgShapeRuleAsync, type ArgShapeRuleResult } from './rules/arg-shape.js';
import { evaluatePathScopeRule } from './rules/path-scope.js';
import { evaluateNetworkScopeRule } from './rules/network-scope.js';
import { evaluateModeConstraintRule } from './rules/mode-constraint.js';

// ── Tool classification ──────────────────────────────────────────────────────────

/**
 * The engine's own file-editing tools. Accept-edits mode approves these by
 * id: they are tools the engine defines, whose only effect is editing the
 * files their arguments name, so the id settles what the mode covers. What
 * any other call does is read by Jev in the gate, and reaches this evaluator
 * as the call's classification (gate/reading.ts classificationFromReading).
 */
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

// ── Mode constraint evaluation ──────────────────────────────────────────────────

interface ModeCheckResult {
  deny: boolean;
  allow: boolean;
  reason?: DecisionReason | undefined;
  step: EvaluationStep;
}

/**
 * evaluateModeLayer, Applies mode-level constraints.
 *
 * Returns a deny decision for certain tool/classification combinations
 * depending on the active mode, or allow for `allow-all` mode.
 */
function evaluateModeLayer(
  mode: PermissionMode,
  toolName: string,
  classification: CommandClassification,
): ModeCheckResult {
  switch (mode) {
    case 'allow-all':
      return {
        deny: false,
        allow: true,
        reason: 'MODE_ALLOW_ALL',
        step: {
          layer: 'mode',
          check: 'mode-allow-all',
          matched: true,
          detail: 'allow-all mode: all tools auto-approved',
        },
      };

    case 'plan':
      // Plan mode blocks every mutating/exec/delegate class; only reads pass.
      if (
        classification === 'write' ||
        classification === 'network' ||
        classification === 'destructive' ||
        classification === 'escalation'
      ) {
        return {
          deny: true,
          allow: false,
          reason: 'MODE_DENY_PLAN',
          step: {
            layer: 'mode',
            check: 'mode-plan-constraint',
            matched: true,
            detail: `plan mode denies ${classification} tool "${toolName}"`,
          },
        };
      }
      break;

    case 'accept-edits':
      // Accept-edits auto-approves only the engine's file-editing tools. A
      // shell command can read as 'write' too, so the mode keys on the tool id
      // rather than the classification; everything else falls through to the
      // policy and default layers and is still gated.
      if (FILE_EDIT_TOOLS.has(toolName)) {
        return {
          deny: false,
          allow: true,
          reason: 'MODE_ALLOW_ACCEPT_EDITS',
          step: {
            layer: 'mode',
            check: 'mode-accept-edits-constraint',
            matched: true,
            detail: `accept-edits mode auto-approves write tool "${toolName}"`,
          },
        };
      }
      break;

    case 'background-restricted':
      // Background mode blocks escalation (agent/delegate) tools
      if (classification === 'escalation') {
        return {
          deny: true,
          allow: false,
          reason: 'MODE_DENY_BACKGROUND',
          step: {
            layer: 'mode',
            check: 'mode-background-constraint',
            matched: true,
            detail: `background-restricted mode denies escalation tool "${toolName}"`,
          },
        };
      }
      break;

    case 'remote-restricted':
      // Remote-restricted mode blocks network tools
      if (classification === 'network') {
        return {
          deny: true,
          allow: false,
          reason: 'MODE_DENY_REMOTE_RESTRICTED',
          step: {
            layer: 'mode',
            check: 'mode-remote-restricted-constraint',
            matched: true,
            detail: `remote-restricted mode denies network tool "${toolName}"`,
          },
        };
      }
      break;

    default:
      // 'default' and 'custom' modes: no mode-level constraints
      break;
  }

  return {
    deny: false,
    allow: false,
    step: {
      layer: 'mode',
      check: `mode-${mode}-constraint`,
      matched: false,
      detail: `mode "${mode}" imposes no constraint on "${toolName}" (${classification})`,
    },
  };
}

// ── Policy rule dispatch ──────────────────────────────────────────────────────────

interface PolicyRuleCheckResult {
  matched: boolean;
  effect: 'allow' | 'deny';
  reason: DecisionReason;
  step: EvaluationStep;
}

/**
 * dispatchPolicyRule, Routes a PolicyRule to its typed evaluator.
 */
function dispatchPolicyRule(
  rule: PolicyRule,
  toolName: string,
  args: Record<string, unknown>,
  activeMode: PermissionMode,
  classification: CommandClassification,
  projectRoot?: string,
  argShape?: ArgShapeRuleResult,
  subjects?: CallSubjects,
): PolicyRuleCheckResult {
  let matched = false;
  let step: EvaluationStep;

  switch (rule.type) {
    case 'prefix': {
      const result = evaluatePrefixRule(rule, toolName, args, subjects?.commands);
      matched = result.matched;
      step = result.step;
      break;
    }
    case 'arg-shape': {
      const result = argShape ?? evaluateArgShapeRule(rule, toolName, args);
      matched = result.matched;
      step = result.step;
      break;
    }
    case 'path-scope': {
      const result = evaluatePathScopeRule(rule, toolName, args, projectRoot, subjects?.paths);
      matched = result.matched;
      step = result.step;
      break;
    }
    case 'network-scope': {
      const result = evaluateNetworkScopeRule(rule, toolName, args, subjects?.hosts);
      matched = result.matched;
      step = result.step;
      break;
    }
    case 'mode-constraint': {
      const result = evaluateModeConstraintRule(rule, toolName, activeMode, classification);
      matched = result.matched;
      step = result.step;
      break;
    }
  }

  const reason: DecisionReason =
    rule.effect === 'allow'
      ? rule.origin === 'user'
        ? 'RULE_ALLOW_USER'
        : 'RULE_ALLOW_MANAGED'
      : rule.origin === 'user'
        ? 'RULE_DENY_USER'
        : 'RULE_DENY_MANAGED';

  return { matched, effect: rule.effect, reason, step };
}

// ── LayeredPolicyEvaluator ───────────────────────────────────────────────────────

/**
 * LayeredPolicyEvaluator, Core runtime permissions evaluator.
 *
 * Evaluates tool calls through the mode, policy-rule and default layers in
 * priority order. It holds no state between calls: the gate builds one per
 * decision over a rule list it already owns, and answers given in a session
 * live in the permission manager, not here.
 *
 * Usage:
 * ```ts
 * const evaluator = new LayeredPolicyEvaluator({ mode: 'default', rules: [] });
 * const decision = evaluator.evaluate('write', { path: '/tmp/out.txt' }, 'write');
 * ```
 */
export class LayeredPolicyEvaluator {
  private readonly mode: PermissionMode;
  private readonly rules: readonly PolicyRule[];
  private readonly defaultEffect: 'allow' | 'deny';
  private readonly projectRoot?: string | undefined;
  /** Provenance from the loaded policy bundle, if any. */
  private readonly provenance?: BundleProvenance | undefined;

  constructor(config: PermissionsConfig, provenance?: BundleProvenance) {
    this.mode = config.mode ?? 'default';
    this.rules = config.rules ?? [];
    this.defaultEffect = config.defaultEffect ?? 'deny';
    this.projectRoot = config.projectRoot;
    this.provenance = provenance;
  }

  /**
   * evaluate, Evaluates a tool call and returns a PermissionDecision.
   *
   * @param toolName, The tool name being called.
   * @param args    , The arguments passed to the tool.
   * @param classification, What the call does, from the gate's reading.
   * @param subjects, The paths, commands and hosts the call names, from the tool's declaration.
   */
  /** @deprecated Synchronous compatibility only. Production callers use evaluateAsync. */
  evaluate(toolName: string, args: Record<string, unknown>, classification: CommandClassification, subjects?: CallSubjects): PermissionDecision {
    const walk = this.evaluateSteps(toolName, args, classification, subjects);
    let next = walk.next();
    while (!next.done) next = walk.next(evaluateArgShapeRule(next.value, toolName, args));
    return next.value;
  }

  /**
   * The rule list and arguments are the caller's owned copies and do not change;
   * only an arg-shape rule awaits, so the caller's check runs after that await.
   */
  async evaluateAsync(toolName: string, args: Record<string, unknown>, classification: CommandClassification, options: JudgmentReadingOptions & { readonly subjects?: CallSubjects | undefined } = {}): Promise<PermissionDecision> {
    const current = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
    current();
    const walk = this.evaluateSteps(toolName, args, classification, options.subjects);
    let next = walk.next();
    while (!next.done) {
      const result = await evaluateArgShapeRuleAsync(next.value, toolName, args, { signal: options.signal, assertCurrent: current });
      current(); next = walk.next(result);
    }
    return next.value;
  }

  private *evaluateSteps(
    toolName: string,
    args: Record<string, unknown>,
    classification: CommandClassification,
    subjects: CallSubjects | undefined,
  ): Generator<Extract<PolicyRule, { type: 'arg-shape' }>, PermissionDecision, ArgShapeRuleResult> {
    const trace: EvaluationStep[] = [];

    // ── Layer 2: Mode constraints ───────────────────────────────────
    const modeResult = evaluateModeLayer(this.mode, toolName, classification);
    trace.push(modeResult.step);
    if (modeResult.deny) {
      return this.finalize({
        allowed: false,
        reason: modeResult.reason ?? 'MODE_DENY_PLAN',
        sourceLayer: 'mode',
        toolName,
        args,
        classification,
        trace,
      });
    }
    if (modeResult.allow) {
      return this.finalize({
        allowed: true,
        reason: modeResult.reason ?? 'MODE_ALLOW_ALL',
        sourceLayer: 'mode',
        toolName,
        args,
        classification,
        trace,
      });
    }

// ── Layer 4: Policy rules (managed denies, then user before managed, first match wins) ─────
    // An administrator's deny is a ceiling: no user or remembered allow may sit ahead of it.
    const managedDenies = this.rules.filter((r) => r.origin === 'managed' && r.effect === 'deny');
    const userRules = this.rules.filter((r) => r.origin === 'user');
    const managedRules = this.rules.filter((r) => r.origin === 'managed' && r.effect !== 'deny');
    const orderedRules = [...managedDenies, ...userRules, ...managedRules];

    for (const rule of orderedRules) {
      const argShape = rule.type === 'arg-shape' ? yield rule : undefined;
      const result = dispatchPolicyRule(rule, toolName, args, this.mode, classification, this.projectRoot, argShape, subjects);
      trace.push(result.step);
      if (result.matched) {
        return this.finalize({
          allowed: result.effect === 'allow',
          reason: result.reason,
          sourceLayer: 'policy',
          toolName,
          args,
          classification,
          trace,
        });
      }
    }

    // ── Layer 5: Default policy ─────────────────────────────────────
    // Default: auto-allow reads, apply configured defaultEffect for everything else
    const defaultAllow =
      this.defaultEffect === 'allow' || classification === 'read';
    const defaultReason: DecisionReason = defaultAllow ? 'DEFAULT_ALLOW' : 'DEFAULT_DENY';
    trace.push({
      layer: 'default',
      check: 'default-policy',
      matched: true,
      detail: `no rule matched; default=${defaultAllow ? 'allow' : 'deny'} (classification=${classification})`,
    });

    return this.finalize({
      allowed: defaultAllow,
      reason: defaultReason,
      sourceLayer: 'default',
      toolName,
      args,
      classification,
      trace,
    });
  }

  /**
   * getMode, Returns the active PermissionMode.
   */
  getMode(): PermissionMode {
    return this.mode;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private finalize(params: {
    allowed: boolean;
    reason: DecisionReason;
    sourceLayer: SourceLayer;
    toolName: string;
    args: Record<string, unknown>;
    classification: CommandClassification;
    trace: EvaluationStep[];
  }): PermissionDecision {
    const decision: PermissionDecision = {
      allowed: params.allowed,
      reason: params.reason,
      sourceLayer: params.sourceLayer,
      toolName: params.toolName,
      args: params.args,
      classification: params.classification,
      timestamp: Date.now(),
      evaluationTrace: params.trace,
      // Attach provenance from the loaded policy bundle
      ...(this.provenance !== undefined && {
        policyBundleId: this.provenance.policyBundleId,
        signatureStatus: this.provenance.signatureStatus,
        provenanceSource: this.provenance.provenanceSource,
      }),
    };
    return decision;
  }
}
