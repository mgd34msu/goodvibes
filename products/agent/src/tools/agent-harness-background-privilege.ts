import { captureJudgmentPort } from '@goodvibes/engine/errors';
import { gateJudgmentRegistry } from '@goodvibes/engine/platform/platform/gate';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes/engine/platform/platform/runtime/decision-policy';
import { redactSensitiveData } from '@goodvibes/engine/platform/platform/utils';
import type { Battery, YesNoItem } from '@goodvibes/judgment';
import type { CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';

/** Why a command's privilege needs are not known: Jev was not asked, or its reading did not settle. */
export type PrivilegeAssessment = 'not-evaluated' | 'uncertain';

/**
 * Whether a background start would need a privilege prompt. A command whose
 * program is sudo/su/doas/pkexec does, one that never names them does not;
 * both are code. Only a command that mentions one in its arguments is read,
 * once, by Jev (the command masked locally first). When that reading is not
 * taken or does not settle, `privileged` is null with the reason, and the
 * caller answers with its `blocked` shape; nothing is thrown.
 */
export async function withBackgroundPrivilegeCheck<T>(command: string, options: CatalogRankingOptions,
  consume: (privileged: boolean | null, assertCurrent: () => void, assessment?: PrivilegeAssessment) => Promise<T>): Promise<T> {
  const assertCurrent = (): void => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  const program = /^\s*(\S+)/.exec(command)?.[1]?.split('/').at(-1);
  if (program && ['sudo', 'su', 'doas', 'pkexec'].includes(program)) return consume(true, assertCurrent);
  if (!/\b(?:sudo|su|doas|pkexec)\b/.test(command)) return consume(false, assertCurrent);
  if (isClassicOperation()) return consume(null, assertCurrent, 'not-evaluated');
  const privileged = await withConfiguredDecisionModelPolicy(() => decisionOrClassic<boolean | 'uncertain' | null>(async () => {
    const decision = gateJudgmentRegistry.get('engine.gate.sandbox-needs');
    if (!decision || !('run' in decision) || typeof decision.run !== 'function') return null;
    const site = 'agent.background-process.privilege';
    const authority = captureJudgmentPort(site, { signal: options.signal });
    try {
      const run = await (decision as Battery<{ needsPrivilege: YesNoItem }>).runSome(authority.port, { command: redactSensitiveData(command) },
        ['needsPrivilege'], { site, signal: authority.signal });
      const reading = run.readings.needsPrivilege;
      // An absent reading settles nothing, like an uncertain one.
      if (reading === undefined || reading.outcome !== 'act' || reading.verdict === 'uncertain') return 'uncertain';
      run.recordAction(reading.verdict === 'yes' ? 'Keep the background privilege-prompt restriction.' : 'The command mention does not require background privilege.');
      return reading.verdict === 'yes';
    } finally { authority.consumeObservation(); }
  }, () => null)).catch((error: unknown) => {
    if (options.signal?.aborted) throw error;
    return null;
  });
  assertCurrent();
  if (privileged === 'uncertain') return consume(null, assertCurrent, 'uncertain');
  if (privileged === null) return consume(null, assertCurrent, 'not-evaluated');
  return consume(privileged, assertCurrent);
}
