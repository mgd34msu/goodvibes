/**
 * FeatureUnitCard, one platform capability rendered as ONE unit inside its
 * domain group: its real name, its full description (never truncated, wrap or
 * scroll, never clip), its enablement control in its REAL shape, and the typed
 * editors for the settings keys it owns. Everything writes through the same
 * config.set path as every other field, features live on first-class domain
 * settings keys (platform 1.7.1's dissolved feature model), not on a separate
 * enablement namespace.
 *
 * Enablement shapes (feature.enablement.kind):
 *   - boolean : a feature-level toggle writing `true`/`false` to the domain key.
 *   - enum    : a mode select over the key's full schema enum (so inactive
 *               modes such as "off" are real choices); the feature is active
 *               while the value is one of enablement.enabledValues.
 *   - constant: the capability has no separate off switch, its own settings
 *               keys govern runtime activation directly, so no feature-level
 *               control renders and the keys appear as ordinary typed fields.
 *
 * Honest states:
 *   - a runtime-toggleable feature notes that changes apply immediately (the
 *     daemon's live settings bridge derives the internal gate state from the
 *     domain key on every config change).
 *   - a restart-gated feature (`restartRequired`) states that up front, and
 *     while the daemon reports (flags.status) that it runs the feature in a
 *     state other than the saved one, shows both states and offers the daemon
 *     restart that applies it. The marker comes from the running daemon, so it
 *     holds across reloads, devices and whoever saved the change.
 *   - the current state distinguishes an explicit config value from the schema
 *     default.
 */
import { useState } from 'react';
import type { FeatureUnitModel } from '../../lib/settings-model';
import { client as platformClient, type ConfigSetOutcome } from '../../lib/goodvibes';
import type { FeatureGateState, FeaturePendingRestart } from '../../lib/feature-restart-status';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { SettingsField } from './SettingsField';
import type { CommitSettings } from './JudgmentModelFields';
import { Chip } from '../ui/Chip';
import { Select } from '../ui/Select';
import { StatusDot } from '../ui/StatusDot';
import { Toggle } from '../ui/Toggle';

interface FeatureUnitCardProps {
  readonly unit: FeatureUnitModel;
  readonly onCommit: (key: string, value: unknown) => Promise<void>;
  /** Writes settings that belong together as one update; forwarded to each field. */
  readonly onCommitMany: CommitSettings;
  /** Removes one key's explicit value so it reads as its default; forwarded to each field. */
  readonly onReset?: (key: string) => Promise<void>;
  /** What the daemon reported for the last successful config.set of each key this session
   *  (SettingsModal's persistedByKey), keyed by config key, looked up here per field and
   *  for the enablement key itself. */
  readonly persistedByKey: Readonly<Record<string, ConfigSetOutcome>>;
  /** The running daemon's report for this feature when its saved setting is not applied yet (flags.status). */
  readonly pendingRestart: FeaturePendingRestart | null;
  /** The live `payments.currency` value, forwarded to any owned field marked
   *  `unit: 'money'`, see SettingsField's `currency` prop. */
  readonly currency?: string;
}

export function FeatureUnitCard({
  unit,
  onCommit,
  onCommitMany,
  onReset,
  persistedByKey,
  pendingRestart,
  currency,
}: FeatureUnitCardProps) {
  const { feature, enabled, explicit, enablementField, fields, daemonOwned } = unit;
  const enablementPersisted = persistedByKey[feature.enablement.key];
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const kind = feature.enablement.kind;

  async function commitEnablement(value: unknown): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await onCommit(feature.enablement.key, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const enablementControl = (() => {
    if (kind === 'boolean') {
      return (
        <Toggle
          className="settings-field-toggle feature-unit-toggle"
          checked={enabled}
          disabled={saving}
          aria-label={`Enable ${feature.name}`}
          onChange={(next) => void commitEnablement(next)}
        />
      );
    }
    if (kind === 'enum' && enablementField?.enumValues) {
      const current = enablementField.present ? enablementField.liveValue : enablementField.default;
      const value = typeof current === 'string' ? current : '';
      return (
        <div className="feature-unit-mode">
          <span className="feature-unit-mode-label" aria-hidden="true">Mode</span>
          <Select
            className="settings-field-select"
            aria-label={`${feature.name} mode`}
            value={value}
            disabled={saving}
            placement="bottom-end"
            options={[
              ...(enablementField.enumValues.includes(value) ? [] : [{ value, label: value || '(unset)' }]),
              ...enablementField.enumValues.map((opt) => ({ value: opt, label: opt })),
            ]}
            onChange={(next) => void commitEnablement(next)}
          />
        </div>
      );
    }
    // constant, no separate off switch; the fields below govern activation.
    return null;
  })();

  return (
    <section className="feature-unit" data-feature-id={feature.id} data-feature-enabled={enabled}>
      <header className="feature-unit-head">
        <div className="feature-unit-title">
          <h3>
            {feature.name}
            {daemonOwned && (
              <Chip
                size="sm"
                className="feature-unit-daemon-badge"
                title="Daemon-owned: these settings are stored in the daemon's own config and apply to every connected client, not just this browser."
              >
                Daemon-owned
              </Chip>
            )}
          </h3>
          {kind === 'constant' ? (
            <span className="feature-unit-state">Governed by its settings below</span>
          ) : (
            <span className={enabled ? 'feature-unit-state feature-unit-state--enabled' : 'feature-unit-state'}>
              <StatusDot tone={enabled ? 'ok' : 'idle'} />
              {enabled ? 'Enabled' : 'Disabled'}
              {explicit ? '' : ' (default)'}
            </span>
          )}
        </div>
        {enablementControl}
      </header>
      <p className="feature-unit-desc">{feature.description}</p>
      {kind !== 'constant' &&
        (feature.restartRequired ? (
          <p className="feature-unit-note">Enablement changes apply after a daemon restart.</p>
        ) : (
          <p className="feature-unit-note">Changes to this feature apply immediately.</p>
        ))}
      {pendingRestart && <PendingRestartNotice featureId={feature.id} featureName={feature.name} pending={pendingRestart} />}
      {kind === 'enum' && enablementField?.description && (
        <p className="feature-unit-mode-desc">{enablementField.description}</p>
      )}
      {enablementPersisted?.persistedTo && (
        <p className="feature-unit-persisted" role="status">
          Saved: stored in {enablementPersisted.persistedTo}.
        </p>
      )}
      {error && (
        <div className="banner warning" role="alert">
          {error}
        </div>
      )}
      {fields.length > 0 && (
        <div className="feature-unit-fields">
          {fields.map((field) => (
            <SettingsField
              key={field.key}
              field={field}
              onCommit={onCommit}
              onCommitMany={onCommitMany}
              {...(onReset ? { onReset } : {})}
              persisted={persistedByKey[field.key]}
              currency={currency}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function gateStateLabel(state: FeatureGateState): string {
  return state === 'killed' ? 'switched off by a kill switch' : state;
}

/**
 * The daemon's own report that this feature runs in a state other than its
 * saved one, with the restart that applies it. Restarting ends every running
 * turn and drops every connected client, so it is asked once; the daemon's
 * refusal (service management off) is shown as it answered.
 */
function PendingRestartNotice({ featureId, featureName, pending }: {
  readonly featureId: string;
  readonly featureName: string;
  readonly pending: FeaturePendingRestart;
}) {
  const [restarting, setRestarting] = useState(false);
  const confirm = useConfirm();
  const { toast } = useToast();

  async function restartDaemon(): Promise<void> {
    if (restarting) return;
    const ok = await confirm.ask({
      title: 'Restart the daemon?',
      target: featureName,
      description: 'The saved setting applies when the daemon starts again. Work running now stops and every connected client reconnects.',
      confirmLabel: 'Restart daemon',
      tone: 'danger',
    });
    if (!ok) return;
    setRestarting(true);
    try {
      await platformClient.operator.services.restart();
      toast({ title: 'Daemon restarting', description: 'This page reconnects when it is back.', tone: 'success' });
    } catch (problem) {
      toast({ title: 'The daemon did not restart', description: formatError(problem), tone: 'danger' });
    } finally {
      setRestarting(false);
    }
  }

  return (
    <>
      <div className="feature-unit-pending" role="status" data-pending-restart={featureId}>
        <p>
          Saved as {gateStateLabel(pending.saved)}; the daemon is running it {gateStateLabel(pending.running)} until it
          restarts.
        </p>
        <Button size="sm" disabled={restarting} onClick={() => void restartDaemon()}>
          {restarting ? 'Restarting…' : 'Restart daemon'}
        </Button>
      </div>
      {confirm.element}
    </>
  );
}
