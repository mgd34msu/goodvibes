import { captureJudgmentPort, decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { gateJudgmentRegistry } from '@goodvibes-jev/engine/platform/platform/gate';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Battery, YesNoItem } from '@goodvibes-jev/judgment';
import { captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';

/** Reserved literal programs are local policy. Mentions inside arguments or
 * wrappers require interpretation of the complete screened command. The
 * interpretation only resolves this additional background-prompt restriction;
 * recorded execution admission remains independently mandatory. */
export async function withBackgroundPrivilegeCheck<T>(command: string, options: CatalogRankingOptions,
  consume: (privileged: boolean | null, assertCurrent: () => void) => Promise<T>): Promise<T> {
  return withConfiguredDecisionModelPolicy(async () => {
    const optionsCurrent = captureCatalogMethods(options, ['signal', 'assertCurrent', 'sourceOwner', 'retainCurrent']);
    const signal = options.signal, caller = options.assertCurrent;
    const assertNativeCurrent = () => {
      optionsCurrent(); signal?.throwIfAborted(); decisionModelPolicyState();
      const result: unknown = caller?.();
      if (result !== undefined) { drainOwned(result); throw new ToolInputProjectionError('held'); }
      optionsCurrent(); signal?.throwIfAborted();
    };
    assertNativeCurrent();
    const program = /^\s*(\S+)/.exec(command)?.[1]?.split('/').at(-1);
    if (program && ['sudo', 'su', 'doas', 'pkexec'].includes(program)) return consume(true, assertNativeCurrent);
    if (!/\b(?:sudo|su|doas|pkexec)\b/.test(command)) return consume(false, assertNativeCurrent);
    // Unknown privilege requirements retain the foreground/owner restriction.
    // This is not a semantic yes, and cannot authorize a background spawn.
    if (isClassicOperation()) return consume(null, assertNativeCurrent);
    return withModelReadingSource({ command }, options, async (captured, source) => {
      const observed = await decisionOrClassic<{ privileged: boolean | null; assertCurrent: () => void }>(async () => {
        const name = 'engine.gate.sandbox-needs', site = 'agent.background-process.privilege';
        const decision = gateJudgmentRegistry.get(name);
        if (!decision || !('run' in decision) || typeof decision.run !== 'function') throw new ToolInputProjectionError('unavailable');
        const runMethod = decision.run;
        const authority = captureJudgmentPort(site, source);
        const assertCurrent = () => {
          source.assertCurrent?.(); authority.assertCurrent();
          if (gateJudgmentRegistry.get(name) !== decision || decision.run !== runMethod) throw new ToolInputProjectionError('held');
        };
        assertCurrent();
        const run = await (decision as Battery<{ needsPrivilege: YesNoItem }>).run(authority.port, captured,
          { site, only: ['needsPrivilege'], signal: authority.signal, beforeAttempt: assertCurrent });
        assertCurrent();
        const reading = run.readings.needsPrivilege;
        if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new ToolInputProjectionError('held');
        run.recordAction(reading.verdict === 'yes' ? 'Keep the background privilege-prompt restriction.' : 'The command mention does not require background privilege.');
        return { privileged: reading.verdict === 'yes', assertCurrent };
      }, () => ({ privileged: null, assertCurrent: () => { assertNativeCurrent(); source.assertCurrent?.(); } }));
      observed.assertCurrent();
      // Consume exactly once, outside the availability fallback phase.
      return consume(observed.privileged, observed.assertCurrent);
    });
  });
}
