import { useState } from "react";
import {
  captureJudgmentFallbackSettings,
  type JudgmentFallbackSettings,
} from "@goodvibes-jev/engine/sdk/browser/decision-router";
import { DECISION_MODEL_PROFILES } from "@goodvibes-jev/judgment/decisions";
import { useSettingsDraft } from "../../hooks/useSettingsDraft";
import { SettingsDraftConflict } from "./SettingsDraftConflict";
import { Button } from "../ui/Button";
import { Input, Textarea, Field } from "../ui/Field";
import { Select } from "../ui/Select";

export function JudgmentFallbackEditor({
  value,
  onCommit,
}: {
  readonly value: unknown;
  readonly onCommit: (value: readonly JudgmentFallbackSettings[]) => Promise<void>;
}) {
  let source = "",
    malformed = false;
  try {
    if (value === undefined) throw new Error("concealed");
    source = JSON.stringify(captureJudgmentFallbackSettings(value), null, 2);
  } catch {
    malformed = true;
  }
  const [parseError, setParseError] = useState("");
  const draft = useSettingsDraft(
    source,
    (text) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Not valid JSON.");
      }
      try {
        const next = captureJudgmentFallbackSettings(parsed);
        return { value: next, text: JSON.stringify(next, null, 2) };
      } catch {
        throw new Error("Value must be a valid fallback-reference array.");
      }
    },
    onCommit
  );
  let rows: readonly JudgmentFallbackSettings[] = [];
  try {
    const parsed: unknown = JSON.parse(draft.text);
    if (Array.isArray(parsed))
      rows = parsed.filter(
        (row) => row !== null && typeof row === "object" && !Array.isArray(row)
      ) as JudgmentFallbackSettings[];
  } catch {
    /* Advanced JSON remains editable until valid. */
  }
  const update = (index: number, patch: Partial<JudgmentFallbackSettings>) =>
    draft.change(JSON.stringify(rows.map((row, i) => (i === index ? { ...row, ...patch } : row))));
  const reorder = (index: number, step: number) => {
    const next = [...rows],
      target = next[index],
      other = next[index + step];
    if (!target || !other) return;
    next[index] = other;
    next[index + step] = target;
    draft.change(JSON.stringify(next));
  };
  return (
    <div>
      <p>
        Targets are tried in this order after the primary decision model becomes unavailable.
        Credentials are reference names only.
      </p>
      {malformed && (
        <>
          <span className="settings-value settings-value--secret">••••</span>
          <p role="note">
            Stored fallback settings are invalid or concealed. Enter a valid replacement.
          </p>
        </>
      )}
      {rows.map((row, index) => (
        <fieldset key={index} disabled={draft.saving}>
          <legend>Fallback {index + 1}</legend>
          <Field label="Model">
            <Input
              aria-label={`Fallback ${index + 1} model`}
              list="decision-fallback-models"
              value={typeof row.model === "string" ? row.model : ""}
              onChange={(event) => update(index, { model: event.target.value })}
            />
          </Field>
          <Field label="Endpoint">
            <Input
              aria-label={`Fallback ${index + 1} endpoint`}
              value={typeof row.endpoint === "string" ? row.endpoint : ""}
              onChange={(event) => update(index, { endpoint: event.target.value })}
            />
          </Field>
          <Field label="Provider">
            <Select
              aria-label={`Fallback ${index + 1} provider`}
              value={row.backend?.adapter ?? "system-one"}
              options={[
                { value: "system-one", label: "System One" },
                { value: "cloudflare-workers-ai", label: "Cloudflare Workers AI" },
                { value: "laya", label: "Laya" },
              ]}
              onChange={(adapter) =>
                update(index, {
                  backend: {
                    ...row.backend,
                    adapter: adapter as "system-one" | "cloudflare-workers-ai" | "laya",
                    responseModels: adapter === "laya" ? ["laya-rl-agent"] : [],
                  },
                })
              }
            />
          </Field>
          <Field label="Credential source">
            <Select
              aria-label={`Fallback ${index + 1} credential source`}
              value={row.keySource ?? "none"}
              options={[
                { value: "none", label: "No authentication" },
                { value: "env", label: "Environment variable" },
                { value: "secret", label: "Secret store entry" },
              ]}
              onChange={(keySource) =>
                update(index, {
                  keySource: keySource as JudgmentFallbackSettings["keySource"],
                  ...(keySource === "none" ? { keyName: "" } : {}),
                })
              }
            />
          </Field>
          {row.keySource !== "none" && (
            <Field label="Credential reference">
              <Input
                aria-label={`Fallback ${index + 1} credential reference`}
                value={typeof row.keyName === "string" ? row.keyName : ""}
                onChange={(event) => update(index, { keyName: event.target.value })}
              />
            </Field>
          )}
          <Button size="sm" disabled={index === 0} onClick={() => reorder(index, -1)}>
            Move earlier
          </Button>
          <Button size="sm" disabled={index === rows.length - 1} onClick={() => reorder(index, 1)}>
            Move later
          </Button>
          <Button
            size="sm"
            onClick={() => draft.change(JSON.stringify(rows.filter((_, i) => i !== index)))}
          >
            Remove fallback {index + 1}
          </Button>
        </fieldset>
      ))}
      <datalist id="decision-fallback-models">
        {DECISION_MODEL_PROFILES.map((profile) => (
          <option key={profile.id} value={profile.model}>
            {profile.name}
          </option>
        ))}
      </datalist>
      <Button
        size="sm"
        disabled={draft.saving}
        onClick={() =>
          draft.change(
            JSON.stringify([
              ...rows,
              { endpoint: "", model: "jev-latest", keySource: "none", keyName: "" },
            ])
          )
        }
      >
        Add fallback
      </Button>
      <details>
        <summary>Advanced JSON</summary>
        <Textarea
          aria-label="judgment.fallbacks"
          value={draft.text}
          disabled={draft.saving}
          onChange={(event) => {
            setParseError("");
            draft.change(event.target.value);
          }}
        />
      </details>
      <Button
        size="sm"
        disabled={draft.saving || (!draft.dirty && !malformed) || draft.conflicted}
        onClick={() => {
          if (malformed && !draft.dirty) setParseError("Not valid JSON.");
          else void draft.submit();
        }}
      >
        Save
      </Button>
      {draft.conflicted && (
        <SettingsDraftConflict onReset={draft.reset} onSave={() => void draft.submit(true)} />
      )}
      {(parseError || draft.error) && <p role="alert">{parseError || draft.error}</p>}
    </div>
  );
}
