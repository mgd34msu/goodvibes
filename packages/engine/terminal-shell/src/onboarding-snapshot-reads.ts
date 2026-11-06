import type { ConfigManager, GoodVibesConfig } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ServiceInspectionQuery } from '@goodvibes-jev/engine/sdk/platform/runtime/ui';
import type { OnboardingServiceState } from './onboarding-data-types.js';
import { sortUnique } from './onboarding-read-facts.js';
export interface SnapshotReadIssue<Area extends string> {
  readonly area: Area;
  readonly message: string;
}
export async function drainSnapshotReads<T extends readonly unknown[]>(
  reads: T,
): Promise<{
  -readonly [K in keyof T]: Awaited<T[K]>;
}> {
  const drained = Promise.allSettled(reads);
  try {
    return await Promise.all(reads);
  } catch (error) {
    await drained;
    throw error;
  }
}
export function createOnboardingSnapshotReadHelpers<Area extends string>(policy: {
  readonly serviceArea: Area;
  readonly drainOnFailure: boolean;
  readonly error: (error: unknown) => string;
}) {
  const joinReads = policy.drainOnFailure ? drainSnapshotReads : Promise.all.bind(Promise);
  async function buildServicesSnapshot(
    services: Pick<ServiceInspectionQuery, 'getAll' | 'inspect'>,
    assertCurrent: () => void = () => {},
  ): Promise<{
    snapshot: {
      total: number;
      oauthProviderIds: readonly string[];
      services: readonly OnboardingServiceState[];
    };
    issues: readonly SnapshotReadIssue<Area>[];
  }> {
    let configs: ReturnType<OnboardingSnapshotDependencies['services']['getAll']>;
    try {
      assertCurrent();
      configs = services.getAll();
      assertCurrent();
    } catch (error) {
      assertCurrent();
      return {
        snapshot: {
          total: 0,
          oauthProviderIds: [],
          services: [],
        },
        issues: [
          {
            area: policy.serviceArea,
            message: policy.error(error),
          },
        ],
      };
    }
    const names = Object.keys(configs).sort((left, right) => left.localeCompare(right));
    const entryResults = await joinReads(
      names.map(async (name) => {
        const config = configs[name]!;
        try {
          assertCurrent();
          const inspection = await services.inspect(name);
          assertCurrent();
          return {
            entry: {
              name,
              providerId: config.providerId ?? config.name,
              baseUrl: config.baseUrl ?? null,
              authType: config.authType,
              tokenKey: config.tokenKey,
              oauthConfigured: Boolean(config.oauth),
              hasPrimaryCredential: inspection?.hasPrimaryCredential ?? false,
              hasPasswordCredential: inspection?.hasPasswordCredential ?? false,
              hasWebhookUrl: inspection?.hasWebhookUrl ?? false,
              hasSigningSecret: inspection?.hasSigningSecret ?? false,
              hasPublicKey: inspection?.hasPublicKey ?? false,
              hasAppToken: inspection?.hasAppToken ?? false,
            } satisfies OnboardingServiceState,
            issue: null,
          };
        } catch (error) {
          assertCurrent();
          return {
            entry: {
              name,
              providerId: config.providerId ?? config.name,
              baseUrl: config.baseUrl ?? null,
              authType: config.authType,
              tokenKey: config.tokenKey,
              oauthConfigured: Boolean(config.oauth),
              hasPrimaryCredential: false,
              hasPasswordCredential: false,
              hasWebhookUrl: false,
              hasSigningSecret: false,
              hasPublicKey: false,
              hasAppToken: false,
            } satisfies OnboardingServiceState,
            issue: {
              area: policy.serviceArea,
              message: `${name}: ${policy.error(error)}`,
            } satisfies SnapshotReadIssue<Area>,
          };
        }
      }),
    );
    assertCurrent();
    const entries = entryResults.map((result) => result.entry);
    const issues: SnapshotReadIssue<Area>[] = [];
    for (const result of entryResults) {
      if (result.issue) issues.push(result.issue);
    }
    return {
      snapshot: {
        total: entries.length,
        oauthProviderIds: sortUnique(entries.filter((entry) => entry.oauthConfigured).map((entry) => entry.providerId)),
        services: entries,
      },
      issues,
    };
  }
  async function loadOptionalSnapshot<T>(
    area: Area,
    loader: (() => Promise<T>) | undefined,
    fallback: T,
  ): Promise<{
    value: T;
    issue: SnapshotReadIssue<Area> | null;
  }> {
    if (!loader) return { value: fallback, issue: null };
    try {
      return {
        value: await loader(),
        issue: null,
      };
    } catch (error) {
      return {
        value: fallback,
        issue: {
          area,
          message: policy.error(error),
        },
      };
    }
  }
  return { buildServicesSnapshot, loadOptionalSnapshot };
}
export type TerminalOnboardingConfigSnapshot<Key extends keyof GoodVibesConfig> = {
  readonly [K in Key]: K extends 'tools' ? Pick<GoodVibesConfig['tools'], 'llmEnabled' | 'llmProvider' | 'llmModel'> : GoodVibesConfig[K];
};
/** Read categories in product-declared order; tools retain their narrow public shape. */
export function captureOnboardingConfigSnapshot<Key extends keyof GoodVibesConfig>(
  config: Pick<ConfigManager, 'get' | 'getCategory'>,
  keys: readonly Key[],
): TerminalOnboardingConfigSnapshot<Key> {
  const result = {} as {
    [K in Key]: unknown;
  };
  for (const key of keys) {
    result[key] =
      key === 'tools'
        ? {
            llmEnabled: config.get('tools.llmEnabled'),
            llmProvider: config.get('tools.llmProvider'),
            llmModel: config.get('tools.llmModel'),
          }
        : config.getCategory(key);
  }
  return result as TerminalOnboardingConfigSnapshot<Key>;
}
