/**
 * The execution-strategy subcommands of /project-plan:
 *   /project-plan mode auto|single|cohort|background|remote
 *   /project-plan explain
 *   /project-plan override <strategy>
 *   /project-plan status
 *   /project-plan clear
 *
 * The strategy they set is read when /workstream drafts a plan (whether the
 * goal is split into parts); no conversation turn reads it, and every answer
 * that sets it says so. Returns a human-readable result string.
 */

import { AdaptivePlanner, VALID_STRATEGIES } from './adaptive-planner.js';
import type { ExecutionStrategy } from './adaptive-planner.js';
import { logger } from '../utils/logger.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitPlanStrategyOverridden } from '../runtime/emitters/index.js';
import type { AdaptivePlanner as AdaptivePlannerType } from './adaptive-planner.js';

export interface PlanCommandResult {
  /** Human-readable output to show the user. */
  output: string;
  /** Whether the command succeeded. */
  ok: boolean;
}

export interface PlanCommandDeps {
  adaptivePlanner: Pick<
    AdaptivePlannerType,
    'getMode' | 'setMode' | 'explain' | 'override' | 'clearOverride' | 'getOverride' | 'getLatest'
  >;
  runtimeBus?: RuntimeEventBus | null | undefined;
}

/** Where a strategy set here takes effect, said with every answer that sets one. */
const STRATEGY_READER = 'It is read when /workstream drafts a plan (whether to split the goal into parts); no conversation turn reads it.';

function emitStrategyOverride(
  runtimeBus: RuntimeEventBus | null | undefined,
  data: { strategy: ExecutionStrategy | null; clearedBy?: string },
): void {
  if (!runtimeBus) return;
  emitPlanStrategyOverridden(runtimeBus, {
    sessionId: 'system',
    traceId: `planner:override:${data.strategy ?? 'none'}`,
    source: 'plan-command-handler',
  }, data);
}

/**
 * Dispatch a parsed /plan subcommand.
 *
 * @param subcommand - The first word after /plan (e.g. 'mode', 'explain', 'override').
 * @param args       - Remaining tokens.
 */
export function handlePlanCommand(
  deps: PlanCommandDeps,
  subcommand: string,
  args: string[],
): PlanCommandResult {
  switch (subcommand.toLowerCase()) {
    case 'mode': {
      const value = args[0]?.toLowerCase() ?? '';
      if (!value) {
        const current = deps.adaptivePlanner.getMode();
        return {
          ok: true,
          output: `Current mode: **${current}**\n\nAvailable modes: auto | single | cohort | background | remote\n${STRATEGY_READER}`,
        };
      }
      if (!VALID_STRATEGIES.includes(value as ExecutionStrategy)) {
        return {
          ok: false,
          output: `Unknown mode '${value}'. Valid: auto | single | cohort | background | remote`,
        };
      }
      deps.adaptivePlanner.setMode(value as ExecutionStrategy);
      logger.info('[PlanCommandHandler] mode changed', { mode: value });
      return {
        ok: true,
        output: `Execution mode set to **${value}**. ${STRATEGY_READER}`,
      };
    }

    case 'explain': {
      const explanation = deps.adaptivePlanner.explain();
      return { ok: true, output: explanation };
    }

    case 'override': {
      const strategy = args[0]?.toLowerCase() ?? '';
      if (!strategy) {
        return {
          ok: false,
          output: 'Usage: /project-plan override <strategy>\n'
            + 'Strategies: auto | single | cohort | background | remote\n'
            + 'Use /project-plan override auto to clear the override.',
        };
      }
      const result = deps.adaptivePlanner.override(strategy);
      if (!result.ok) {
        const explanation = AdaptivePlanner.explainReasonCode(result.reasonCode);
        logger.warn('[PlanCommandHandler] override rejected', { strategy, reasonCode: result.reasonCode });
        return {
          ok: false,
          output: `Override rejected: ${explanation}`,
        };
      }
      if (result.strategy === 'auto') {
        // override('auto') already cleared the override internally
        logger.info('[PlanCommandHandler] override cleared via auto');
        emitStrategyOverride(deps.runtimeBus, { strategy: 'auto', clearedBy: 'override(auto)' });
        return {
          ok: true,
          output: `Execution strategy override cleared; the planner chooses again. ${STRATEGY_READER}`,
        };
      }
      logger.info('[PlanCommandHandler] override applied', { strategy: result.strategy });
      emitStrategyOverride(deps.runtimeBus, { strategy: result.strategy });
      return {
        ok: true,
        output: `Execution strategy overridden to **${result.strategy.toUpperCase()}**.\n`
          + AdaptivePlanner.explainReasonCode('OVERRIDE_IN_EFFECT') + `\n${STRATEGY_READER}`,
      };
    }

    case 'clear': {
      deps.adaptivePlanner.clearOverride();
      deps.adaptivePlanner.setMode('auto');
      logger.info('[PlanCommandHandler] mode and override reset to auto');
      emitStrategyOverride(deps.runtimeBus, { strategy: 'auto', clearedBy: 'clear' });
      return {
        ok: true,
        output: `Planner mode and override reset to **auto**. ${STRATEGY_READER}`,
      };
    }

    case 'status': {
      const mode     = deps.adaptivePlanner.getMode();
      const override = deps.adaptivePlanner.getOverride();
      const latest   = deps.adaptivePlanner.getLatest();
      const lines = [
        `Mode:     ${mode.toUpperCase()}`,
        `Override: ${override ? override.toUpperCase() + ' [ACTIVE]' : 'none'}`,
      ];
      if (latest) {
        lines.push(
          `Last:     ${latest.selected.toUpperCase()}`,
          `Reason:   ${latest.reasonCode}`,
          `          ${AdaptivePlanner.explainReasonCode(latest.reasonCode)}`,
        );
      }
      return { ok: true, output: lines.join('\n') };
    }

    default: {
      return {
        ok: false,
        output: [
          `Unknown /project-plan strategy subcommand: '${subcommand}'.`,
          '',
          'Available commands:',
          '  /project-plan mode [auto|single|cohort|background|remote]  - get or set mode',
          '  /project-plan override <strategy>                          - force a strategy',
          '  /project-plan explain                                      - explain last decision',
          '  /project-plan status                                       - show current state',
          '  /project-plan clear                                        - reset to auto',
          '',
          STRATEGY_READER,
        ].join('\n'),
      };
    }
  }
}
