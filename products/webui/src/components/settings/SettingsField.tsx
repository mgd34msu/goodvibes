import { validEndpointURL } from '@goodvibes/judgment/decisions';
import { JudgmentFallbackEditor } from "./JudgmentFallbackEditor";
import { JudgmentModelField, JudgmentProviderField, commitJudgmentDestination, type CommitSettings } from "./JudgmentModelFields";
import { DecisionRouterEditor } from "./DecisionRouterEditor";
/**
 * SettingsField, one typed config editor row, driven by the platform schema. Laid
 * out as a settings-dialog row: a readable label, the key in mono and the
 * description on the left, the kit control on the right (stacked beneath on a
 * phone, and for wide editors). No native widgets.
 *
 *   boolean → kit Toggle (commits immediately)
 *   enum    → kit Select of the schema's enumValues (commits immediately)
 *   number  → numeric input, committed on blur/Enter, client-parsed to a finite
 *             number; the schema validationHint is shown as the accepted range
 *   string  → text input, committed on blur/Enter
 *   secret  → masked display + explicit "Replace" that reveals a WRITE-ONLY
 *             field (the stored value is never round-tripped back into an input)
 *   object  → a REAL structured editor, never a JSON blob: pricing.modelPrices
 *             gets the per-model price-row editor (ModelPricesEditor); any
 *             future object-typed key falls back to a validating JSON form
 *             that at least round-trips honestly until it gets its own editor
 *
 * A few keys get a specialized editor ahead of the generic type dispatch:
 *   daemon.timezone        → TimezonePicker, a searchable IANA-zone select
 *                             (never free text) with an explicit "UTC (unset)"
 *                             option that writes ''.
 *   payments.enabled       → PaymentsEnabledField: turning it on asks which of
 *                             the two ways purchases run (confirmEveryPurchase)
 *                             and writes both in one update.
 *   payments.cvvHandling   → CvvHandlingField, an enum select that surfaces
 *                             CVV_PROMPT_TRADEOFF_WARNING the moment 'prompt'
 *                             is selected.
 *   payments.budget.*      → MoneyField for any schema key marked
 *                             `unit: 'money'` (platform 2.0.5's money-value.ts),
 *                             the plain amount is displayed and entered as-is,
 *                             with no unit conversion; detection reads the
 *                             schema's `unit` mark, never the key's name.
 *
 * Card material (a card number, expiry, or CVV) never reaches this component:
 * CONFIG_SCHEMA never declares such a key (schema-domain-payments.ts's own
 * header), and settings-model.ts drops any matching key it finds in the live
 * config too (lib/card-material.ts) before it ever becomes a field or row.
 *
 * Commits call onCommit(key, value); it resolves on success (the parent
 * reconciles via a config refetch) and rejects on daemon rejection, which this
 * row surfaces inline (plus the parent's toast). Nothing is faked: an unset key
 * shows its schema default distinctly, and a rejected write keeps the row's edit
 * state so the user can correct it.
 */
import { useRef, useState } from "react";
import {
  captureStructuredCredentialReferenceConfigValue,
  isStructuredCredentialReferenceConfigKey,
} from "@goodvibes/engine/platform/platform/judgment-browser/catalogs";
import { useSettingsDraft } from "../../hooks/useSettingsDraft";
import { SettingsDraftConflict } from "./SettingsDraftConflict";
import { maskSecretValue } from "../../lib/config-redaction";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Input, Textarea } from "../ui/Field";
import { Select } from "../ui/Select";
import { Toggle } from "../ui/Toggle";
import { isMoneyField } from "../../lib/money";
import { appliesWhenWords, type ConfigFieldModel } from "../../lib/settings-model";
import type { ConfigSetOutcome } from "../../lib/goodvibes";
import { ModelPricesEditor } from "./ModelPricesEditor";
import { TimezonePicker } from "./TimezonePicker";
import { MoneyField } from "./MoneyField";
import { CvvHandlingField } from "./CvvHandlingField";
import { PaymentsEnabledField } from "./PaymentsEnabledField";

interface SettingsFieldProps {
  readonly field: ConfigFieldModel;
  readonly onCommit: (key: string, value: unknown) => Promise<void>;
  /** Writes settings that belong together (a decision destination and its credential source) as one update. */
  readonly onCommitMany: CommitSettings;
  /** Removes this key's explicit value on the daemon so it reads as its default again. */
  readonly onReset?: (key: string) => Promise<void>;
  /** What the daemon reported for the last successful config.set of THIS key this
   *  session (SettingsModal's persistedByKey, looked up by the caller), undefined
   *  until this row has been saved at least once. */
  readonly persisted?: ConfigSetOutcome;
  /** The live `payments.currency` value, used only by `unit: 'money'` fields
   *  to label the amount input; defaults to the schema's own default ('USD')
   *  when the caller does not pass one. */
  readonly currency?: string;
  /** The daemon's current value for a key, read just before an editor that rewrites a whole object saves. */
  readonly readLatest?: (key: string) => Promise<unknown>;
  /** For `payments.enabled`: how purchases run now (`payments.confirmEveryPurchase`) and the stop window's minutes. */
  readonly purchaseMode?: { readonly confirmEveryPurchase: boolean; readonly vetoMinutes: number };
}

/** True when any own property on the way down is an accessor: reading it would run daemon-supplied code. */
function hasAccessor(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== "object") return false;
  if (depth > 8) return true;
  for (const d of Object.values(Object.getOwnPropertyDescriptors(v))) {
    if (d.get || d.set || hasAccessor(d.value, depth + 1)) return true;
  }
  return false;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // A value with accessors is never serialised to compare it; it counts as different so the row stays resettable.
  if (hasAccessor(a) || hasAccessor(b)) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function effectiveValue(field: ConfigFieldModel): unknown {
  return field.present ? field.liveValue : field.default;
}

/** Render a scalar config value into an input's text form, without stringifying objects blindly. */
function scalarToText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}

export function SettingsField({ field, onCommit, onCommitMany, onReset, persisted, currency, readLatest, purchaseMode }: SettingsFieldProps) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Secret replacements are write-only: never seed them from live config.
  const [draft, setDraft] = useState("");
  const inFlight = useRef(false);
  const [revealing, setRevealing] = useState(false);

  async function commit(value: unknown): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await onCommit(field.key, value);
      setRevealing(false);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  /** Turning payments on: the way purchases run and the switch, in one update. */
  async function turnPaymentsOn(confirmEveryPurchase: boolean): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await onCommitMany([["payments.confirmEveryPurchase", confirmEveryPurchase], ["payments.enabled", true]]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  const defaultNote = !field.present ? (
    <span
      className="settings-field-default"
      title="Not set in the daemon config, showing the built-in default."
    >
      default
    </span>
  ) : null;

  const control = (() => {
    if (field.key === "judgment.model")
      return (
        <JudgmentModelField
          value={effectiveValue(field)}
          onCommit={(value) => onCommit(field.key, value)}
        />
      );
    if (field.key === "judgment.backend")
      return <JudgmentProviderField value={effectiveValue(field)} onCommitMany={onCommitMany} />;
    // Object-typed keys get structured editors (see module header).
    if (field.type === "object") {
      if (field.key === "judgment.fallbacks")
        return (
          <JudgmentFallbackEditor
            value={effectiveValue(field)}
            onCommit={(value) => onCommit(field.key, value)}
          />
        );
      if (field.key === "provider.decisionRouter")
        return (
          <DecisionRouterEditor
            value={effectiveValue(field)}
            onCommit={(next) => onCommit(field.key, next)}
          />
        );
      if (field.key === "pricing.modelPrices") {
        // The editor owns its saving/error state, commits go straight to the
        // parent's config.set so a rejection surfaces inside the editor row.
        return (
          <ModelPricesEditor
            value={effectiveValue(field)}
            onCommit={(next) => onCommit(field.key, next)}
            {...(readLatest ? { readLatest: () => readLatest(field.key) } : {})}
          />
        );
      }
      return (
        <ObjectJsonField field={field} saving={saving} onCommit={(value) => void commit(value)} />
      );
    }

    // daemon.timezone, a searchable IANA-zone picker, never free text.
    if (field.key === "daemon.timezone") {
      const current = effectiveValue(field);
      const value = typeof current === "string" ? current : "";
      return (
        <TimezonePicker value={value} disabled={saving} onCommit={(next) => void commit(next)} />
      );
    }

    // payments.enabled, turned on only together with a choice of how purchases run.
    if (field.key === "payments.enabled" && purchaseMode) {
      return (
        <PaymentsEnabledField
          enabled={Boolean(effectiveValue(field))}
          confirmEveryPurchase={purchaseMode.confirmEveryPurchase}
          vetoMinutes={purchaseMode.vetoMinutes}
          disabled={saving}
          onTurnOff={() => void commit(false)}
          onTurnOn={(confirm) => void turnPaymentsOn(confirm)}
        />
      );
    }

    // payments.cvvHandling, an enum select that surfaces the trade-off
    // warning at the moment 'prompt' is selected.
    if (field.type === "enum" && field.key === "payments.cvvHandling" && field.enumValues) {
      const current = effectiveValue(field);
      const value = typeof current === "string" ? current : "";
      return (
        <CvvHandlingField
          value={value}
          enumValues={field.enumValues}
          disabled={saving}
          onCommit={(next) => void commit(next)}
        />
      );
    }

    // A schema key marked unit: 'money', a plain amount, displayed and
    // entered as-is with no unit conversion.
    if (field.type === "number" && isMoneyField(field.unit)) {
      const current = effectiveValue(field);
      const value = typeof current === "number" ? current : 0;
      return (
        <MoneyField
          key={field.key}
          value={value}
          currency={currency ?? "USD"}
          disabled={saving}
          onCommit={(amount) => onCommit(field.key, amount)}
        />
      );
    }

    // Secret string, masked, write-only replace.
    if (field.isSecret && field.type === "string") {
      const raw = effectiveValue(field);
      const masked = typeof raw === "string" && raw ? maskSecretValue(raw) : "(unset)";
      if (!revealing) {
        return (
          <div className="settings-field-secret">
            <span className="settings-value settings-value--secret">{masked}</span>
            <Button
              size="sm"
              className="settings-field-replace"
              onClick={() => {
                setDraft("");
                setError(null);
                setRevealing(true);
              }}
            >
              Replace
            </Button>
          </div>
        );
      }
      return (
        <div className="settings-field-secret">
          <Input
            type="password"
            autoComplete="new-password"
            aria-label={`New value for ${field.key}`}
            value={draft}
            disabled={saving}
            placeholder="Enter new value (write-only)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit(draft);
            }}
          />
          <Button
            size="sm"
            disabled={saving}
            onClick={() => {
              setDraft("");
              setError(null);
              setRevealing(false);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="settings-field-save"
            disabled={saving}
            onClick={() => void commit(draft)}
          >
            Save
          </Button>
        </div>
      );
    }

    if (field.type === "boolean") {
      const checked = Boolean(effectiveValue(field));
      return (
        <Toggle
          className="settings-field-toggle"
          checked={checked}
          disabled={saving}
          aria-label={field.key}
          onChange={(next) => void commit(next)}
        />
      );
    }

    if (field.type === "enum" && field.enumValues) {
      const current = effectiveValue(field);
      const value = typeof current === "string" ? current : scalarToText(current);
      return (
        <Select
          className="settings-field-select"
          aria-label={field.key}
          value={value}
          disabled={saving}
          placement="bottom-end"
          options={[
            ...(field.enumValues.includes(value) ? [] : [{ value, label: value || "(unset)" }]),
            // The default decision policy reads "Hybrid (default)"; only the bare value is stored.
            ...field.enumValues.map((opt) => ({ value: opt, label: field.key === "judgment.policy" && opt === "Hybrid" ? "Hybrid (default)" : opt })),
          ]}
          onChange={(next) => void commit(next)}
        />
      );
    }

    return (
      <ScalarSettingsField
        key={field.key}
        field={field}
        onCommit={async (value) => {
          if (field.key === "judgment.endpoint") {
            if (typeof value !== "string" || value !== "" && !validEndpointURL(value)) {
              throw new Error("Use an http(s) decision endpoint without embedded credentials, a query or a fragment.");
            }
            // Changing a destination never implicitly forwards the previous
            // target's credential. The owner selects its source explicitly.
            if (value !== effectiveValue(field)) {
              await commitJudgmentDestination(onCommitMany, field.key, value);
              return;
            }
          }
          await onCommit(field.key, value);
        }}
      />
    );
  })();

  // Wide editors (structured objects, a revealed secret, the timezone picker)
  // sit under the text instead of beside it.
  const stacked =
    field.type === "object" ||
    // The decision model's choosers are wide pickers: they sit under their label, not beside it.
    field.key === "judgment.model" ||
    field.key === "judgment.backend" ||
    field.key === "daemon.timezone" ||
    field.key === "payments.enabled" ||
    (field.isSecret && field.type === "string" && revealing);

  return (
    <div
      className={stacked ? "settings-field settings-field--stacked" : "settings-field"}
      data-config-key={field.key}
      data-daemon-owned={field.daemonOwned}
    >
      <div className="settings-field-text">
        <div className="settings-field-label">{field.label}</div>
        <div className="settings-field-head">
          <code className="settings-field-key">{field.key}</code>
          {field.daemonOwned && (
            <Chip
              size="sm"
              className="settings-field-daemon-badge"
              title="Daemon-owned: stored in the daemon's own config and applies to every connected client, not just this browser."
            >
              Daemon-owned
            </Chip>
          )}
          {defaultNote}
          {field.validationHint && field.type === "number" && (
            <span className="settings-field-hint">{field.validationHint}</span>
          )}
        </div>
        {field.description && <p className="settings-field-desc">{field.description}</p>}
        {appliesWhenWords(field) && <p className="settings-field-desc settings-field-applies">{appliesWhenWords(field)}</p>}
      </div>
      <div className="settings-field-control">
        {control}
        {onReset && field.present && !field.isSecret && !sameValue(field.liveValue, field.default) && (
          <Button
            size="sm"
            className="settings-field-reset"
            disabled={saving}
            title={field.key === "judgment.endpoint"
              ? "Return to the default decision endpoint. Authentication is reset to none; choose its credential source again."
              : "Remove the saved value so this setting follows the built-in default again."}
            onClick={() => {
              if (inFlight.current) return;
              inFlight.current = true;
              setSaving(true);
              setError(null);
              // Resetting the decision endpoint moves its credential's destination: it
              // clears the credential source in the same update, as an edit does.
              // Any other destination the daemon refuses with the credential named.
              (field.key === "judgment.endpoint"
                ? commitJudgmentDestination(onCommitMany, field.key, field.default)
                : onReset(field.key))
                .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                .finally(() => {
                  inFlight.current = false;
                  setSaving(false);
                });
            }}
          >
            Reset to default
          </Button>
        )}
      </div>
      {persisted?.persistedTo && (
        <p className="settings-field-persisted" role="status">
          Saved: stored in {persisted.persistedTo}.
        </p>
      )}
      {error && (
        <div className="banner warning settings-field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** Text and ordinary number fields share refresh, conflict and save ownership. */
function ScalarSettingsField({
  field,
  onCommit,
}: {
  readonly field: ConfigFieldModel;
  readonly onCommit: (value: unknown) => Promise<void>;
}) {
  const draft = useSettingsDraft<string | number>(
    scalarToText(effectiveValue(field)),
    (text) => {
      if (field.type !== "number") return { value: text, text };
      const value = Number(text);
      if (text.trim() === "" || !Number.isFinite(value)) {
        throw new Error(
          `Enter a finite number${field.validationHint ? ` (${field.validationHint})` : ""}`
        );
      }
      return { value, text: String(value) };
    },
    onCommit
  );
  return (
    <div className="settings-field-draft">
      <Input
        className="settings-field-input"
        type="text"
        inputMode={field.type === "number" ? "decimal" : undefined}
        aria-label={field.key}
        value={draft.text}
        disabled={draft.saving}
        onChange={(event) => draft.change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape" && (draft.dirty || draft.conflicted || draft.error !== null)) {
            event.preventDefault();
            event.stopPropagation();
            draft.reset();
          }
        }}
        onBlur={() => void draft.submit()}
      />
      {draft.conflicted && !draft.saving && (
        <SettingsDraftConflict onReset={draft.reset} onSave={() => void draft.submit(true)} />
      )}
      {draft.error && (
        <div className="banner warning settings-field-error" role="alert">
          {draft.error}
        </div>
      )}
    </div>
  );
}

/**
 * Fallback editor for an object-typed schema key that has no dedicated
 * structured editor yet: shows the current value and accepts a replacement as
 * validated JSON. Declared credential-reference arrays use the canonical
 * capture before display and before writes; other keys require an object.
 * pricing.modelPrices never reaches this, it has ModelPricesEditor.
 */
function ObjectJsonField({
  field,
  saving,
  onCommit,
}: {
  readonly field: ConfigFieldModel;
  readonly saving: boolean;
  readonly onCommit: (value: unknown) => void;
}) {
  const current = field.present ? field.liveValue : field.default;
  const structuredReferences = isStructuredCredentialReferenceConfigKey(field.key);
  let captured: unknown = current;
  let masked = false;
  if (structuredReferences) {
    try {
      captured = captureStructuredCredentialReferenceConfigValue(field.key, current);
    } catch {
      captured = undefined;
      masked = true;
    }
  }
  const [draft, setDraft] = useState(() => (masked ? "" : JSON.stringify(captured ?? {}, null, 2)));
  const [parseError, setParseError] = useState<string | null>(null);
  return (
    <div className="settings-field-object">
      {masked && (
        <>
          <span className="settings-value settings-value--secret">••••</span>
          <p role="note">
            Stored fallback references are malformed and hidden. Enter a valid replacement array.
          </p>
        </>
      )}
      <Textarea
        aria-label={field.key}
        value={draft}
        disabled={saving}
        rows={Math.min(10, draft.split("\n").length + 1)}
        onChange={(e) => setDraft(e.target.value)}
      />
      <Button
        variant="primary"
        size="sm"
        disabled={saving}
        onClick={() => {
          try {
            const parsed: unknown = JSON.parse(draft);
            if (structuredReferences) {
              let references: ReturnType<typeof captureStructuredCredentialReferenceConfigValue>;
              try {
                references = captureStructuredCredentialReferenceConfigValue(field.key, parsed);
              } catch {
                setParseError("Value must be a valid fallback-reference array.");
                return;
              }
              setParseError(null);
              onCommit(references);
              return;
            }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              setParseError("Value must be a JSON object.");
              return;
            }
            setParseError(null);
            onCommit(parsed);
          } catch {
            setParseError("Not valid JSON.");
          }
        }}
      >
        Save
      </Button>
      {parseError && (
        <div className="banner warning" role="alert">
          {parseError}
        </div>
      )}
    </div>
  );
}
