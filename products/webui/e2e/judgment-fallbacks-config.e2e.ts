/** Strict editable references, with genuine daemon validation and disk persistence. */
import { expect, test } from "@playwright/test";
import type { JudgmentFallbackSettings } from "@goodvibes-jev/engine/platform/platform/config";
import { parseBrowserJudgmentRequest } from "@goodvibes-jev/engine/daemon-api";
import { expectNoHorizontalScroll, openSettings } from "./support/app";
import { installTerminalThemeDaemon } from "./support/terminal-theme-fixture";

test("fallback-reference arrays save and reload without exposing inline credentials", async ({
  page,
}) => {
  const daemon = await installTerminalThemeDaemon(page);
  const { host } = daemon;
  const original = [
    {
      endpoint: "https://first.example.test/v1",
      model: "jev-latest",
      keySource: "env",
      keyName: "FIRST_JEV_KEY",
    },
    {
      endpoint: "https://second.example.test",
      model: "jev-latest",
      keySource: "secret",
      keyName: "judgment/second-key",
    },
  ] satisfies JudgmentFallbackSettings[];
  const replacement = [
    {
      endpoint: "https://backup.example.test/v1",
      model: "jev-latest",
      keySource: "secret",
      keyName: "judgment/backup-key",
    },
    {
      endpoint: "https://last.example.test",
      model: "jev-latest",
      keySource: "env",
      keyName: "LAST_JEV_KEY",
    },
  ] satisfies JudgmentFallbackSettings[];
  try {
    host.manager.set("judgment.fallbacks", original);
    host.reload();
    const dialog = await openSettings(page, "models");
    const field = dialog.locator('[data-config-key="judgment.fallbacks"]');
    await field.getByText("Advanced JSON", { exact: true }).click();
    const editor = field.getByRole("textbox", { name: "judgment.fallbacks", exact: true });
    await expect(editor).toHaveValue(JSON.stringify(original, null, 2));
    await editor.fill(JSON.stringify(replacement, null, 2));
    await field.getByRole("button", { name: "Save", exact: true }).click();
    await expect(field.getByRole("status")).toContainText(host.settingsPath);
    expect(host.persisted()).toMatchObject({ judgment: { fallbacks: replacement } });
    host.reload();
    expect(host.manager.get("judgment.fallbacks")).toEqual(replacement);
    await openSettings(page, "models");
    await field.getByText("Advanced JSON", { exact: true }).click();
    await expect(editor).toHaveValue(JSON.stringify(replacement, null, 2));
    await expectNoHorizontalScroll(page);

    const malformed = [{ ...replacement[0], apiKey: "synthetic-inline-private-value" }];
    await editor.fill(JSON.stringify(malformed));
    await field.getByRole("button", { name: "Save", exact: true }).click();
    await expect(field.getByRole("alert")).toHaveText(
      "Value must be a valid fallback-reference array."
    );
    expect(host.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(host.manager.get("judgment.fallbacks")).toEqual(replacement);

    expect(host.persisted()).toMatchObject({ judgment: { fallbacks: replacement } });
    expect(host.requests.filter((request) => request.method === "POST")).toEqual([
      { method: "POST", body: { key: "judgment.fallbacks", value: replacement }, status: 200 },
    ]);
    for (const request of daemon.requests.filter(
      (request) => request.path === "/api/judgment/batteries/run"
    )) {
      const reading = parseBrowserJudgmentRequest(request.body);
      if (
        reading.battery !== "webui.config.credential-key" &&
        reading.battery !== "webui.settings.card-material-key"
      )
        continue;
      expect(reading.input.keys).not.toContain("judgment.fallbacks");
      expect(reading.input.keys.some((key) => key.startsWith("judgment.fallbacks."))).toBe(false);
      expect(JSON.stringify(reading.input)).not.toContain("judgment/backup-key");
      expect(JSON.stringify(reading.input)).not.toContain("synthetic-inline-private-value");
    }
  } finally {
    try {
      if (!page.isClosed()) await page.unroute("**/config");
    } finally {
      host.cleanup();
    }
  }
});
