import type { Tool, ToolCall } from '../../../types/tools.js';
import type { ToolRuntimeContext } from '../context.js';
import type { PhaseResult, ToolExecutionRecord } from '../types.js';
import {
  emitBoundaryChecked,
  emitGateDecision,
  emitGateRequested,
  emitPresetEvaluated,
  emitStakesRead,
} from '../../emitters/gate.js';
import type { PermissionCheckResult } from '../../../permissions/types.js';
import { buildToolDenial, buildDenialErrorMessage } from '../../../permissions/denial.js';
import { summarizeError } from '../../../utils/error-display.js';
import { repairRecordArguments } from './execute.js';

/**
 * permission, Phase 3 of the tool execution pipeline.
 *
 * Delegates to PermissionManager.check(). If permission is denied,
 * the phase aborts and no further phases are run.
 *
 * The resolved args used here account for any input updates from the
 * prehook phase and for auto-repair (both stored as `_updatedArgs` on the
 * record), so the approval covers the arguments the tool will actually receive.
 */
/**
 * Build the aborting permission-denied phase result, carrying structured,
 * call-scoped denial data (reason + scope) AND a self-explaining error string so
 * the asking agent can continue and report honestly rather than parse a bare
 * "Permission denied" line.
 */
function deniedPhaseResult(
  toolName: string,
  reason: string,
  scope: string,
  start: number,
  userReason?: string,
  detail?: string,
): PhaseResult {
  const source = { reasonCode: reason, sourceLayer: scope, userReason, detail };
  return {
    phase: 'permissioned',
    success: false,
    durationMs: performance.now() - start,
    error: buildDenialErrorMessage(toolName, source),
    abort: true,
    denial: buildToolDenial(source),
  };
}

export async function permissionPhase(
  call: ToolCall,
  tool: Tool,
  context: ToolRuntimeContext,
  record: ToolExecutionRecord,
): Promise<PhaseResult> {
  const start = performance.now();

  // Approve what will run: repair renames argument keys, so asking about the
  // pre-repair arguments could approve a weaker reading of the same call.
  const effectiveArgs = await repairRecordArguments(call, tool, record);

  const resolvePermissionResult = async (): Promise<PermissionCheckResult> => {
    const manager = context.permissionManager as unknown as {
      checkDetailed?: ((toolName: string, args: Record<string, unknown>, attribution?: undefined, options?: { readonly definition: Tool['definition'] }) => Promise<PermissionCheckResult>) | undefined;
      check?: ((toolName: string, args: Record<string, unknown>) => Promise<boolean>) | undefined;
      getCategory: (toolName: string) => string;
    };

    if (typeof manager.checkDetailed === 'function') {
      // The definition carries the facts the gate classifies by, a declared-dangerous tool among them.
      return manager.checkDetailed(call.name, effectiveArgs, undefined, { definition: tool.definition });
    }

    if (typeof manager.check === 'function') {
      const approved = await manager.check(call.name, effectiveArgs);
      return {
        approved,
        persisted: false,
        sourceLayer: approved ? 'config_policy' : 'user_prompt',
        reasonCode: approved ? 'config_allow' : 'user_denied',
        analysis: {
          classification: 'generic',
          riskLevel: 'medium',
          summary: `Permission ${approved ? 'approved' : 'denied'} for ${call.name}`,
          reasons: [],
        },
      };
    }

    throw new Error('PermissionManager is missing both checkDetailed() and check()');
  };

  try {
    if (context.runtimeBus) {
      const analysis = await resolvePermissionResult();
      emitGateRequested(context.runtimeBus, {
        sessionId: context.ids.sessionId,
        traceId: context.ids.traceId,
        source: 'permission-manager',
      }, {
        callId: call.id,
        tool: call.name,
        args: effectiveArgs,
        category: analysis.category ?? context.permissionManager.getCategory(call.name),
        classification: analysis.analysis.classification,
        riskLevel: analysis.analysis.riskLevel,
        summary: analysis.analysis.summary,
        reasons: analysis.analysis.reasons,
      });

      const ctx = { sessionId: context.ids.sessionId, traceId: context.ids.traceId, source: 'permission-manager' };
      if (analysis.boundary) {
        emitBoundaryChecked(context.runtimeBus, ctx, {
          callId: call.id,
          tool: call.name,
          passed: analysis.boundary.passed,
          refusedBy: analysis.boundary.refusedBy,
          checks: analysis.boundary.checks.map(({ check, result }) => ({ check, result })),
        });
      }
      if (analysis.reading) {
        emitStakesRead(context.runtimeBus, ctx, {
          callId: call.id,
          tool: call.name,
          family: analysis.reading.family,
          stakes: analysis.reading.stakes,
          ...analysis.reading.facts,
          uncertain: [...analysis.reading.uncertain],
        });
      }
      if (analysis.preset && analysis.reading) {
        emitPresetEvaluated(context.runtimeBus, ctx, {
          callId: call.id,
          tool: call.name,
          preset: analysis.preset.preset,
          stakes: analysis.reading.stakes,
          result: analysis.preset.action,
        });
      }

      emitGateDecision(context.runtimeBus, {
        sessionId: context.ids.sessionId,
        traceId: context.ids.traceId,
        source: 'permission-manager',
      }, {
        callId: call.id,
        tool: call.name,
        category: analysis.category ?? context.permissionManager.getCategory(call.name),
        approved: analysis.approved,
        source: 'permission-manager',
        sourceLayer: analysis.sourceLayer,
        persisted: analysis.persisted,
        reasonCode: analysis.reasonCode,
        classification: analysis.analysis.classification,
        riskLevel: analysis.analysis.riskLevel,
        summary: analysis.analysis.summary,
      });

      if (!analysis.approved) {
        return deniedPhaseResult(call.name, analysis.reasonCode, analysis.sourceLayer, start, analysis.userReason, analysis.detail);
      }
    } else {
      const analysis = await resolvePermissionResult();
      if (!analysis.approved) {
        return deniedPhaseResult(call.name, analysis.reasonCode, analysis.sourceLayer, start, analysis.userReason, analysis.detail);
      }
    }

    return {
      phase: 'permissioned',
      success: true,
      durationMs: performance.now() - start,
    };
  } catch (err) {
    const message = summarizeError(err);
    return {
      phase: 'permissioned',
      success: false,
      durationMs: performance.now() - start,
      error: `Permission check threw: ${message}`,
      abort: true,
    };
  }
}
