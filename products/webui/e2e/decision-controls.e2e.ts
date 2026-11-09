import { expect, test } from "@playwright/test";
import { DECISION_MODEL_PROFILES } from "@goodvibes-jev/judgment/decisions";
import { expectNoHorizontalScroll, openSettings } from "./support/app";
import { installTerminalThemeDaemon } from "./support/terminal-theme-fixture";

test("decision controls save models, provider, policy and ordered fallbacks through the daemon", async ({
  page,
}) => {
  const daemon = await installTerminalThemeDaemon(page);
  const { host } = daemon;
  try {
    const originalChat = host.manager.get("provider.model");
    host.manager.set("judgment.keySource", "env");
    host.manager.set("judgment.fallbacks", []);
    host.reload();
    const dialog = await openSettings(page, "models");
    const model = dialog.getByRole("combobox", { name: "Decision model", exact: true });
    for (const profile of DECISION_MODEL_PROFILES) {
      await model.click();
      await page.getByRole("option", { name: profile.name, exact: true }).click();
      await expect.poll(() => host.manager.get("judgment.model")).toBe(profile.model);
    }
    await dialog.getByRole("combobox", { name: "Decision provider", exact: true }).click();
    await page.getByRole("option", { name: "Laya", exact: true }).click();
    await expect.poll(() => host.manager.get("judgment.backend").adapter).toBe("laya");
    expect(host.manager.get("judgment.keySource")).toBe("none");

    const policy = dialog.locator('[data-config-key="judgment.policy"]');
    await policy.getByRole("combobox").click();
    await page.getByRole("option", { name: "Classic - Off", exact: true }).click();
    await expect.poll(() => host.manager.get("judgment.policy")).toBe("Classic - Off");

    const fallbacks = dialog.locator('[data-config-key="judgment.fallbacks"]');
    await fallbacks.getByRole("button", { name: "Add fallback", exact: true }).click();
    await fallbacks
      .getByRole("combobox", { name: "Fallback 1 model", exact: true })
      .fill("kev-latest");
    await fallbacks
      .getByRole("textbox", { name: "Fallback 1 endpoint", exact: true })
      .fill("http://127.0.0.1:4321");
    await fallbacks.getByRole("button", { name: "Add fallback", exact: true }).click();
    await fallbacks.getByRole("combobox", { name: "Fallback 2 model", exact: true }).fill("dgemma");
    await fallbacks
      .getByRole("textbox", { name: "Fallback 2 endpoint", exact: true })
      .fill("http://127.0.0.1:4322");
    await fallbacks.getByRole("button", { name: "Move earlier", exact: true }).nth(1).click();
    await fallbacks.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() => host.manager.get("judgment.fallbacks").map((target) => target.model))
      .toEqual(["dgemma", "kev-latest"]);
    await fallbacks.getByRole("button", { name: "Remove fallback 2", exact: true }).click();
    await fallbacks.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => host.manager.get("judgment.fallbacks")).toHaveLength(1);
    host.reload();
    expect(host.manager.get("provider.model")).toBe(originalChat);
    expect(host.persisted()).toMatchObject({
      judgment: { policy: "Classic - Off", model: "english" },
    });
    await openSettings(page, "models");
    await expect(
      dialog.getByRole("combobox", { name: "Decision model", exact: true })
    ).toContainText("Laya");
    await expect(
      fallbacks.getByRole("combobox", { name: "Fallback 1 model", exact: true })
    ).toHaveValue("dgemma");
    await expectNoHorizontalScroll(page);
  } finally {
    try {
      if (!page.isClosed()) await page.unroute("**/config");
    } finally {
      host.cleanup();
    }
  }
});
