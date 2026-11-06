import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { gateJudgmentRegistry, prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { JudgmentPort, NamedDecision } from '@goodvibes-jev/judgment/decisions';
import { captureCatalogData, captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';

const nativeThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const nativeApply = Reflect.apply;
function assertNativeCancellation(signal: AbortSignal | undefined): void {
  if (signal) nativeApply(nativeThrowIfAborted, signal, []);
}

interface CanonicalDefinition extends NamedDecision {
  readonly items: unknown;
}

/** The input is already protected by the caller's withModelReadingSource scope. */
export async function withCanonicalReading<T>(site: string, definitions: readonly CanonicalDefinition[], options: CatalogRankingOptions,
  read: (port: JudgmentPort, assertCurrent: () => void, signal: AbortSignal | undefined) => Promise<T>,
  classic?: () => T | Promise<T>): Promise<T> {
  return withConfiguredDecisionModelPolicy(async () => {
    const registrySlots = captureCatalogMethods(gateJudgmentRegistry, ['get']);
    const guards = definitions.map(definition => {
      const slots = captureCatalogMethods(definition, ['name', 'version', 'description', 'accuracyFloor', 'model', 'items', 'fixtureCount', 'run', 'checkFixtures']);
      const metadata = () => captureCatalogData({ name: definition.name, version: definition.version, description: definition.description,
        accuracyFloor: definition.accuracyFloor, model: definition.model, items: definition.items, fixtureCount: definition.fixtureCount });
      const revision = JSON.stringify(metadata());
      return () => {
        slots();
        if (gateJudgmentRegistry.get(definition.name) !== definition || JSON.stringify(metadata()) !== revision)
          throw new ToolInputProjectionError('held');
      };
    });
    const assertDefinitionCurrent = () => { registrySlots(); for (const guard of guards) guard(); };
    options.retainCurrent?.(assertDefinitionCurrent, `${site}.definition`);
    const assertCurrent = () => { assertNativeCancellation(options.signal); options.assertCurrent?.(); assertDefinitionCurrent(); };
    assertCurrent();
    const semantic = async () => {
      const authority = captureJudgmentPort(site, { signal: options.signal, assertCurrent, prepareResultCapture: prepareJudgmentResult });
      try {
        const result = await read(authority.port, authority.assertCurrent, authority.signal);
        authority.assertCurrent();
        return result;
      } finally {
        const restriction = authority.consumeObservation();
        const retained = () => {
          assertDefinitionCurrent(); assertNativeCancellation(options.signal); assertNativeCancellation(authority.signal);
          if (!isClassicOperation()) restriction.assertCurrent();
        };
        options.retainCurrent?.(retained, site); retained();
      }
    };
    if (!classic) return semantic();
    return decisionOrClassic(semantic, () => { assertCurrent(); return classic(); }, () => { assertCurrent(); return true; });
  });
}
