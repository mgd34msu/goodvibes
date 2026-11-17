/**
 * The schema-driven config surface, lifted out of the old SettingsModal so the
 * settings dialog can render each config namespace inside the section it
 * belongs to (sections.ts). The mechanism is unchanged:
 *
 * Rows are driven by the platform's CONFIG_SCHEMA (types / enums / defaults /
 * descriptions / validation hints), merged with the daemon's live config.get()
 * values, so each key gets a TYPED editor: booleans toggle, enums select,
 * numbers validate, strings text, secrets stay masked/write-only
 * (config-redaction.ts). Every platform capability renders as ONE unit in its
 * DOMAIN group, its enablement control in its real shape (boolean toggle /
 * enum mode select / constant, per platform FEATURE_SETTINGS) together with the
 * settings keys it owns (settings-model.ts). Owned keys never double-list as
 * orphan rows in their namespace.
 *
 * Restart honesty: the daemon reports which restart-gated features run in a
 * state other than their saved setting (flags.status); a feature it names shows
 * a pending-restart marker with both states, whoever saved it and whenever.
 * The read is refetched after a save of a restart-gated feature's enablement key.
 *
 * Honesty bars:
 *   - an admin-scope refusal (403) on config.get reads distinctly from a generic
 *     fetch failure;
 *   - a secret-shaped key never renders its stored value;
 *   - declared card-material keys are never listed; a key the schema does not
 *     declare is listed read-only with its value masked. Both facts come from
 *     the engine's declarations, never from a model.
 *
 * Writes go through config.set one key at a time (the daemon's real /config
 * contract), except a declared credential, which goes through credentials.set
 * so the value lands in the secret store and the config holds a reference. The
 * daemon refuses any key outside its config schema, so keys it holds beyond the
 * schema are listed read-only and have no editor.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { isStructuredCredentialReferenceConfigKey } from '@goodvibes-jev/engine/platform/platform/judgment-browser/catalogs';
import { client as platformClient, type ConfigSetOutcome } from '../../../lib/goodvibes';
import type { FeaturePendingRestart } from '../../../lib/feature-restart-status';
import { queryKeys } from '../../../lib/queries';
import { FEATURE_SETTINGS } from '../../../lib/generated/config-schema';
import { formatError, isAdminRequiredError } from '../../../lib/errors';
import { useToast } from '../../../lib/toast';
import { ErrorState } from '../../feedback/ErrorState';
import { SkeletonBlock } from '../../feedback/SkeletonBlock';
import { SettingsField } from '../SettingsField';
import { SettingsHeadingLevel } from './parts';
import { FeatureUnitCard } from '../FeatureUnitCard';
import { PaymentCardEntry } from '../PaymentCardEntry';
import { PaymentWindows } from '../PaymentWindows';
import { TelegramCursorRecovery } from '../TelegramCursorRecovery';
import { displayConfigValue, isUndeclaredConfigKey, SECRET_CONFIG_KEYS } from '../../../lib/config-redaction';
import {
  buildSettingsModel,
  filterSettingsModel,
  readConfigPath,
  type SettingsGroupModel,
} from '../../../lib/settings-model';

/**
 * A declared credential goes through credentials.set: the daemon stores the
 * value in its secret store, reads it back, and only then points the config key
 * at it. config.set refuses a literal credential, so this is the one write
 * path that works for every key in the daemon's credential list.
 */
async function setCredential(key: string, value: unknown): Promise<ConfigSetOutcome> {
  if (typeof value !== 'string') throw new Error(`${key} takes a text value.`);
  const stored = await platformClient.operator.credentials.set({ key, value });
  return {
    success: stored.success,
    key,
    persistedTo: `the daemon's secret store (${stored.scope} scope, ${stored.reference})`,
    daemonOwned: true,
  };
}

/** A key in the daemon's credential list whose value is one secret (not a validated list of references). */
function isCredentialKey(key: string): boolean {
  return SECRET_CONFIG_KEYS.has(key) && !isStructuredCredentialReferenceConfigKey(key);
}

interface ConfigSettingsValue {
  config: UseQueryResult;
  groups: SettingsGroupModel[];
  currency: string;
  refused: boolean;
  degraded: boolean;
  commit: (key: string, value: unknown) => Promise<void>;
  /** Write settings that belong together as one update (config.setMany): none changes unless all do. */
  commitMany: (entries: readonly (readonly [string, unknown])[]) => Promise<void>;
  /** Remove one key's explicit value on the daemon so it reads as its default again. */
  reset: (key: string) => Promise<void>;
  /** The daemon's current value for one key, for editors whose write replaces a whole object. */
  readLatest: (key: string) => Promise<unknown>;
  persistedByKey: Readonly<Record<string, ConfigSetOutcome>>;
  /** What the running daemon reports per restart-gated feature id whose saved setting is not applied yet. */
  pendingRestart: ReadonlyMap<string, FeaturePendingRestart>;
}

const FEATURE_RESTART_STATUS_KEY = ['flags', 'status'] as const;

/** Enablement keys of restart-gated features: only a save of one of these can change flags.status. */
const RESTART_GATED_KEYS: ReadonlySet<string> = new Set(
  FEATURE_SETTINGS.filter((feature) => feature.restartRequired).map((feature) => feature.enablement.key),
);

const ConfigSettingsContext = createContext<ConfigSettingsValue | null>(null);

export function ConfigSettingsProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // What the daemon reported back for the last successful config.set of each key
  // (persistedTo / tier / daemonOwned), never fabricated from config.get, which
  // returns the persisted tree only. Cleared whenever the dialog remounts.
  const [persistedByKey, setPersistedByKey] = useState<Readonly<Record<string, ConfigSetOutcome>>>({});

  const config = useQuery({
    queryKey: queryKeys.config,
    queryFn: () => platformClient.operator.config.get(),
    enabled,
    retry: false,
  });

  // Read beside config.get: the saved tree cannot say what the daemon runs. A
  // daemon without this read (or a refusal) leaves no marker; config still shows.
  const restartStatus = useQuery({
    queryKey: FEATURE_RESTART_STATUS_KEY,
    queryFn: () => platformClient.operator.flags.status(),
    enabled,
    retry: false,
  });
  const pendingRestart = useMemo(
    () => new Map((restartStatus.data?.pendingRestart ?? []).map((entry) => [entry.featureId, entry] as const)),
    [restartStatus.data],
  );

  const groups = useMemo(() => buildSettingsModel(config.data), [config.data]);
  // payments.currency's live value, for MoneyField's currency label, read from
  // the live config since it may sit in a different group than the money field.
  const currency = useMemo(() => {
    const { present, value } = readConfigPath(config.data, 'payments.currency');
    return present && typeof value === 'string' && value ? value : 'USD';
  }, [config.data]);

  const refused = config.isError && isAdminRequiredError(config.error);
  const degraded = config.isError && !refused;

  /**
   * Single write path: config.set one key, reconcile via refetch, surface errors.
   * config.set REJECTS on a non-2xx or network failure; the catch re-throws so the
   * calling row keeps its edit state and shows the failure inline, on top of the
   * toast here. config.get is NOT invalidated on failure, so the row keeps showing
   * the value the daemon actually holds.
   */
  const commit = useCallback(
    async (key: string, value: unknown): Promise<void> => {
      try {
        const outcome = isCredentialKey(key)
          ? await setCredential(key, value)
          : await platformClient.operator.config.set(key, value);
        setPersistedByKey((prev) => ({ ...prev, [key]: outcome }));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.config }),
          RESTART_GATED_KEYS.has(key) ? queryClient.invalidateQueries({ queryKey: FEATURE_RESTART_STATUS_KEY }) : undefined,
        ]);
        toast({
          title: 'Config saved',
          description: outcome.persistedTo ? `${key} updated: stored in ${outcome.persistedTo}.` : `${key} updated.`,
          tone: 'success',
        });
      } catch (error) {
        toast({ title: 'Failed to save config', description: formatError(error), tone: 'danger' });
        throw error;
      }
    },
    [queryClient, toast],
  );

  const commitMany = useCallback(
    async (entries: readonly (readonly [string, unknown])[]): Promise<void> => {
      const keys = entries.map(([key]) => key);
      try {
        const outcome = await platformClient.operator.config.setMany(entries);
        setPersistedByKey((prev) => ({
          ...prev,
          ...Object.fromEntries(outcome.entries.map((entry) => [entry.key, { ...entry, success: outcome.success }] as const)),
        }));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.config }),
          keys.some((key) => RESTART_GATED_KEYS.has(key)) ? queryClient.invalidateQueries({ queryKey: FEATURE_RESTART_STATUS_KEY }) : undefined,
        ]);
        toast({ title: 'Config saved', description: `${keys.join(' and ')} updated together.`, tone: 'success' });
      } catch (error) {
        toast({ title: 'Failed to save config', description: formatError(error), tone: 'danger' });
        throw error;
      }
    },
    [queryClient, toast],
  );

  const reset = useCallback(
    async (key: string): Promise<void> => {
      try {
        const outcome = await platformClient.operator.config.reset(key);
        setPersistedByKey((prev) => ({ ...prev, [key]: outcome }));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.config }),
          RESTART_GATED_KEYS.has(key) ? queryClient.invalidateQueries({ queryKey: FEATURE_RESTART_STATUS_KEY }) : undefined,
        ]);
        toast({ title: 'Setting reset', description: `${key} is back to its default.`, tone: 'success' });
      } catch (error) {
        toast({ title: 'Failed to reset setting', description: formatError(error), tone: 'danger' });
        throw error;
      }
    },
    [queryClient, toast],
  );

  const readLatest = useCallback(
    async (key: string): Promise<unknown> => readConfigPath(await platformClient.operator.config.get(), key).value,
    [],
  );

  const value = useMemo<ConfigSettingsValue>(() => ({
    config,
    groups,
    currency,
    refused,
    degraded,
    commit,
    commitMany,
    reset,
    readLatest,
    persistedByKey,
    pendingRestart,
  }), [config, groups, currency, refused, degraded, commit, commitMany, reset, readLatest, persistedByKey, pendingRestart]);

  return <ConfigSettingsContext.Provider value={value}>{children}</ConfigSettingsContext.Provider>;
}

export function useConfigSettings(): ConfigSettingsValue {
  const ctx = useContext(ConfigSettingsContext);
  if (!ctx) throw new Error('useConfigSettings must be used inside ConfigSettingsProvider');
  return ctx;
}

/** The config groups, or the honest loading / refused / degraded state in their place. */
export function ConfigGroupList({
  groups,
  query = '',
  emptyText,
}: {
  /** The groups to render (already narrowed to a section). */
  groups: readonly SettingsGroupModel[];
  /** Narrow to settings matching this search text. */
  query?: string;
  /** Shown when there is nothing to render (after the search). */
  emptyText?: string;
}) {
  const { config, refused, degraded, commit, commitMany, reset, readLatest, persistedByKey, pendingRestart, currency } = useConfigSettings();
  const shown = useMemo(() => filterSettingsModel([...groups], query), [groups, query]);
  // One level under the section heading when the list sits inside a titled section.
  const GroupHeading = useContext(SettingsHeadingLevel) === 4 ? 'h4' : 'h3';

  if (config.isPending) {
    return (
      <div className="settings-skeleton" aria-label="Loading settings" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonBlock key={i} variant="block" height={32} />
        ))}
      </div>
    );
  }
  if (refused) {
    return (
      <div className="settings-degraded" role="status">
        <strong>Admin access required</strong>
        <span>Sign in with an admin-scoped token to view and edit config.</span>
      </div>
    );
  }
  if (degraded) {
    return <ErrorState error={config.error} title="Config unavailable" onRetry={() => void config.refetch()} />;
  }
  if (shown.length === 0) {
    return emptyText ? <p className="settings-empty">{emptyText}</p> : null;
  }

  return (
    <div className="settings-entries">
      {shown.map((group) => (
        <section
          key={group.id}
          className="settings-config-group"
          data-config-group={group.id}
          aria-labelledby={`settings-config-group-${group.id}`}
        >
          <GroupHeading id={`settings-config-group-${group.id}`} className="settings-config-group__title">{group.label}</GroupHeading>
          {/*
            Card entry sits at the top of the Payments group, above the budgets
            and windows that govern how it gets used. It is not a schema-driven
            row and cannot be: card material is deliberately absent from
            CONFIG_SCHEMA (it lives in the daemon secret store). The panel gates
            itself on the platform's entry-surface allowlist.
          */}
          {group.id === 'payments' && <PaymentCardEntry currency={currency} />}
          {group.id === 'payments' && <PaymentWindows />}
          {group.id === 'surfaces' && <TelegramCursorRecovery />}
          {group.featureUnits.map((unit) => (
            <FeatureUnitCard
              key={unit.feature.id}
              unit={unit}
              onCommit={commit}
              onCommitMany={commitMany}
              onReset={reset}
              persistedByKey={persistedByKey}
              pendingRestart={pendingRestart.get(unit.feature.id) ?? null}
              currency={currency}
            />
          ))}
          {group.plainRows.length > 0 && (
            <div className="settings-plain-rows">
              {group.plainRows.map((field) => (
                <SettingsField
                  key={field.key}
                  field={field}
                  onCommit={commit}
                  onCommitMany={commitMany}
                  onReset={reset}
                  readLatest={readLatest}
                  persisted={persistedByKey[field.key]}
                  currency={currency}
                />
              ))}
            </div>
          )}
          {group.rawRows.length > 0 && (
            <div className="settings-raw-rows">
              <p className="settings-raw-note">
                Held by the daemon but not in the config schema; shown read-only. The daemon only accepts
                writes to keys in its config schema, so these cannot be changed from here.
              </p>
              <dl className="settings-readable">
                {group.rawRows.map((row) => (
                  <div key={row.key} className="settings-readable__row">
                    <dt className="settings-readable__key">
                      {row.key}
                      {row.isSecret && <span className="settings-secret-flag"> {isUndeclaredConfigKey(row.key) && !SECRET_CONFIG_KEYS.has(row.key) ? '(masked)' : '(secret)'}</span>}
                      {row.daemonOwned && (
                        <span
                          className="settings-daemon-flag"
                          title="Daemon-owned: stored in the daemon's own config and applies to every client."
                        >
                          {' '}
                          (daemon)
                        </span>
                      )}
                    </dt>
                    <dd className={row.isSecret ? 'settings-value settings-value--secret' : 'settings-value'}>
                      {displayConfigValue(row.key, row.value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
