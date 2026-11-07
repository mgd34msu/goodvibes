import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  captureDecisionRouterSettings,
  DEFAULT_DECISION_ROUTER_SETTINGS,
  type DecisionRouterSettings,
  type DecisionRouterCategory,
} from "@goodvibes-jev/engine/sdk/browser/decision-router";
import { sdk } from "../../lib/goodvibes";
import {
  modelOptionsForProvider,
  providerOptionsFromResponse,
  reasoningOptionsForModel,
} from "../../lib/provider-models";
import { useSettingsDraft } from "../../hooks/useSettingsDraft";
import { SettingsDraftConflict } from "./SettingsDraftConflict";
import { Button } from "../ui/Button";
import { Field, Input, Textarea } from "../ui/Field";
import { Select } from "../ui/Select";

export function DecisionRouterEditor({
  value,
  onCommit,
}: {
  readonly value: unknown;
  readonly onCommit: (next: DecisionRouterSettings) => Promise<void>;
}) {
  const catalog = useQuery({ queryKey: ["models"], queryFn: () => sdk.operator.models.list() });
  const providers = providerOptionsFromResponse(catalog.data).filter(
    (provider) => provider.id !== "decision-router"
  );
  let source: string,
    malformed = false;
  try {
    source = JSON.stringify(captureDecisionRouterSettings(value));
  } catch {
    source = JSON.stringify(DEFAULT_DECISION_ROUTER_SETTINGS);
    malformed = true;
  }
  const draft = useSettingsDraft(
    source,
    (text) => {
      const settings = captureDecisionRouterSettings(JSON.parse(text));
      if (!settings.categories.general?.target)
        throw new Error("Choose a General provider and model first.");
      return { value: settings, text: JSON.stringify(settings) };
    },
    onCommit
  );
  // Drafts can temporarily have an empty model or description while editing.
  // Only the validated submit path publishes them to daemon configuration.
  const settings = JSON.parse(draft.text) as DecisionRouterSettings;
  const [customId, setCustomId] = useState("");
  const [customError, setCustomError] = useState("");
  const update = (id: string, category: DecisionRouterCategory) =>
    draft.change(
      JSON.stringify({ ...settings, categories: { ...settings.categories, [id]: category } })
    );

  return (
    <div className="decision-router-editor">
      <p>
        Select <strong>Decision Router / auto</strong> in the model picker to enable routing. Other
        providers use their usual model. Empty categories use General. Decision-model credentials
        and fallback targets are configured separately under Judgment.
      </p>
      {malformed && (
        <p role="alert">
          Stored routing settings are invalid. Save a valid replacement before using Decision
          Router.
        </p>
      )}
      {catalog.isError && (
        <p role="status">
          Model discovery is unavailable. Existing targets remain editable; check provider
          configuration.
        </p>
      )}
      {Object.entries(settings.categories).map(([id, category]) => {
        const providerId = category.target?.provider ?? "";
        const provider = providers.find((entry) => entry.id === providerId);
        const models = provider
          ? modelOptionsForProvider(
              provider.value,
              providers.map((entry) => entry.value)
            )
          : [];
        const target = category.target;
        const key = target ? `${target.provider}:${target.model}` : "";
        const efforts =
          reasoningOptionsForModel(
            providers.map((entry) => entry.value),
            key
          )?.levels ?? [];
        return (
          <fieldset key={id} disabled={draft.saving}>
            <legend>
              {category.label}
              {id === "general" ? " (required)" : ""}
            </legend>
            <Field label={`${category.label} description`}>
              <Textarea
                aria-label={`${category.label} description`}
                value={category.description}
                onChange={(event) => update(id, { ...category, description: event.target.value })}
              />
            </Field>
            <Field label="Provider">
              <Select
                aria-label={`${category.label} provider`}
                value={providerId}
                options={[
                  {
                    value: "",
                    label: id === "general" ? "Choose General provider" : "Use General",
                  },
                  ...(providerId && !provider ? [{ value: providerId, label: providerId }] : []),
                  ...providers.map((entry) => ({ value: entry.id, label: entry.label })),
                ]}
                onChange={(next) =>
                  update(id, { ...category, target: next ? { provider: next, model: "" } : null })
                }
              />
            </Field>
            {target && (
              <>
                <Field label="Model">
                  <Input
                    aria-label={`${category.label} model`}
                    value={target.model}
                    list={`router-models-${id}`}
                    onChange={(event) =>
                      update(id, { ...category, target: { ...target, model: event.target.value } })
                    }
                  />
                </Field>
                <datalist id={`router-models-${id}`}>
                  {models.map((entry) => (
                    <option key={entry.registryKey} value={entry.rawModelId}>
                      {entry.label}
                    </option>
                  ))}
                </datalist>
                <Field label="Effort">
                  <Select
                    aria-label={`${category.label} effort`}
                    value={target.effort ?? ""}
                    options={[
                      { value: "", label: "Model default" },
                      ...(target.effort && !efforts.includes(target.effort)
                        ? [
                            {
                              value: target.effort,
                              label: `${target.effort} (rechecked when routing)`,
                            },
                          ]
                        : []),
                      ...efforts.map((effort) => ({ value: effort, label: effort })),
                    ]}
                    onChange={(effort) =>
                      update(id, {
                        ...category,
                        target: {
                          provider: target.provider,
                          model: target.model,
                          ...(effort ? { effort } : {}),
                        },
                      })
                    }
                  />
                </Field>
              </>
            )}
            {!Object.hasOwn(DEFAULT_DECISION_ROUTER_SETTINGS.categories, id) && (
              <Button
                size="sm"
                onClick={() => {
                  const categories = { ...settings.categories };
                  delete categories[id];
                  draft.change(JSON.stringify({ ...settings, categories }));
                }}
              >
                Remove {category.label}
              </Button>
            )}
          </fieldset>
        );
      })}
      <Field label="Initial routing context (characters)">
        <Input
          aria-label="Initial routing context (characters)"
          type="number"
          min={1}
          value={settings.initialContextChars}
          onChange={(event) =>
            draft.change(
              JSON.stringify({ ...settings, initialContextChars: Number(event.target.value) })
            )
          }
        />
      </Field>
      <Field label="Expanded routing context (characters)">
        <Input
          aria-label="Expanded routing context (characters)"
          type="number"
          min={1}
          value={settings.expandedContextChars}
          onChange={(event) =>
            draft.change(
              JSON.stringify({ ...settings, expandedContextChars: Number(event.target.value) })
            )
          }
        />
      </Field>
      <Field label="Custom category id">
        <Input
          aria-label="Custom category id"
          value={customId}
          onChange={(event) => setCustomId(event.target.value)}
        />
      </Field>
      <Button
        size="sm"
        disabled={draft.saving}
        onClick={() => {
          if (
            !/^[a-z][a-z0-9-]{0,63}$/.test(customId) ||
            Object.hasOwn(settings.categories, customId) ||
            Object.keys(settings.categories).length >= 63
          ) {
            setCustomError(
              "Use a new lowercase category id with letters, numbers and hyphens (at most 63 categories)."
            );
            return;
          }
          update(customId, {
            label: customId,
            description: "Describe which requests belong to this category.",
            target: null,
          });
          setCustomId("");
          setCustomError("");
        }}
      >
        Add category
      </Button>
      {customError && <p role="alert">{customError}</p>}
      <div>
        <Button
          variant="primary"
          size="sm"
          disabled={draft.saving || !draft.dirty || draft.conflicted}
          onClick={() => void draft.submit()}
        >
          Save routing
        </Button>
      </div>
      {draft.conflicted && (
        <SettingsDraftConflict onReset={draft.reset} onSave={() => void draft.submit(true)} />
      )}
      {draft.error && <p role="alert">{draft.error}</p>}
    </div>
  );
}
