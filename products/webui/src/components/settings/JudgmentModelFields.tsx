import { useState } from "react";
import {
  DECISION_MODEL_PROFILES,
  captureJudgmentBackendSettings,
} from "@goodvibes-jev/judgment/decisions";
import { Select } from "../ui/Select";
import { Input } from "../ui/Field";
import { Button } from "../ui/Button";

export function JudgmentModelField({
  value,
  onCommit,
}: {
  readonly value: unknown;
  readonly onCommit: (value: string) => Promise<void>;
}) {
  const current = typeof value === "string" ? value : "";
  const [custom, setCustom] = useState(current);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (model: string) => {
    setSaving(true);
    setError("");
    try {
      await onCommit(model);
    } catch {
      setError("Unable to save the decision model. Check the settings connection.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div>
      <Select
        aria-label="Decision model"
        disabled={saving}
        value={current}
        options={[
          { value: "", label: "Use environment / hosted default" },
          ...(!DECISION_MODEL_PROFILES.some((profile) => profile.model === current) && current
            ? [{ value: current, label: current }]
            : []),
          ...DECISION_MODEL_PROFILES.map((profile) => ({
            value: profile.model,
            label: profile.name,
          })),
        ]}
        onChange={(model) => void save(model)}
      />
      <p>
        Set the matching provider and endpoint in Judgment settings. Credentials use references,
        never inline keys.
      </p>
      <details>
        <summary>Custom decision model</summary>
        <Input
          aria-label="Custom decision model"
          value={custom}
          disabled={saving}
          onChange={(event) => setCustom(event.target.value)}
        />
        <Button
          size="sm"
          disabled={saving || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(custom)}
          onClick={() => void save(custom)}
        >
          Save model
        </Button>
      </details>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function JudgmentProviderField({
  value,
  onCommit,
}: {
  readonly value: unknown;
  readonly onCommit: (key: string, value: unknown) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  let backend: ReturnType<typeof captureJudgmentBackendSettings>;
  try {
    backend = captureJudgmentBackendSettings(value);
  } catch {
    backend = {};
  }
  const save = async (adapter: string) => {
    setSaving(true);
    setError("");
    try {
      // Protocol changes never carry a credential into an unconfigured destination.
      await onCommit("judgment.keySource", "none");
      await onCommit(
        "judgment.backend",
        captureJudgmentBackendSettings({
          ...backend,
          adapter,
          responseModels: adapter === "laya" ? ["laya-rl-agent"] : [],
        })
      );
    } catch {
      setError("Unable to save the decision provider. Check the settings connection.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div>
      <Select
        aria-label="Decision provider"
        value={backend.adapter ?? "system-one"}
        disabled={saving}
        options={[
          { value: "system-one", label: "System One — Jev, DiffusionGemma Jev, Kev-9B" },
          { value: "cloudflare-workers-ai", label: "Cloudflare Workers AI — Clef / Clef-flash" },
          { value: "laya", label: "Laya" },
        ]}
        onChange={(adapter) => void save(adapter)}
      />
      <p>
        Set the endpoint and credential reference for this provider. Authentication is reset to none
        when the provider changes; choose its credential source explicitly. Your chat model is
        unchanged.
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
