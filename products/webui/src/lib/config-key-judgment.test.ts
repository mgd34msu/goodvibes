import { afterEach, expect, mock, test } from "bun:test";
import type { BrowserJudgmentRequest } from "@goodvibes-jev/engine/daemon-api";
import { invalidateClientLifetime } from "./client-lifetime";
import { alternatingMatches, judgmentResponse, responseCorruptions } from "../test-support/judgment-response";

type Request = BrowserJudgmentRequest<"webui.config.credential-key">;
let calls: { request: Request; signal: AbortSignal }[] = [];
let transport: (request: Request) => Promise<unknown> = async (request) => response(request);
mock.module("./goodvibes", () => ({
  runBrowserJudgment: (request: Request, signal: AbortSignal) => {
    calls.push({ request, signal });
    return transport(request);
  },
}));
const { readConfigKey, readConfigKeyResponse } = await import("./config-key-judgment");
const request = (keys = ["CUSTOM_A", "CUSTOM_B"]): Request => ({
  protocolVersion: 1,
  batteryVersion: 1,
  battery: "webui.config.credential-key",
  requestId: crypto.randomUUID(),
  input: { keys },
});
function response(input: Request, held = false) {
  return judgmentResponse(input, alternatingMatches(input.input.keys), held);
}
afterEach(() => {
  calls = [];
  transport = async (input) => response(input);
});

test("valid names-only projection preserves boolean correspondence and per-key evidence", () => {
  const input = request();
  expect(readConfigKeyResponse(input, response(input))).toEqual({
    status: "ready",
    matches: [true, false],
  });
});
test("uncertainty exposes neither a partial match nor a guessed credential", () => {
  const input = request();
  expect(readConfigKeyResponse(input, response(input, true))).toEqual({ status: "held" });
});
for (const [label, corrupt] of responseCorruptions)
  test(`${label} substitution fails closed`, () => {
    const input = request();
    const raw = response(input);
    corrupt(raw);
    expect(readConfigKeyResponse(input, raw)).toBeUndefined();
  });
test.each(["wrong-reason", "settled-outcomes", "extra-value"])(
  "%s held envelope cannot smuggle an actionable value",
  (failure) => {
    const input = request();
    const raw = response(input, true);
    if (failure === "wrong-reason") Object.assign(raw, { reason: "other" });
    if (failure === "settled-outcomes") {
      Object.values(raw.readings).forEach((reading) => {
        reading.outcome = "act";
        reading.verdict = "yes";
      });
      raw.outcome = "act";
    }
    if (failure === "extra-value") Object.assign(raw, { value: { matches: [true, false] } });
    expect(readConfigKeyResponse(input, raw)).toBeUndefined();
  }
);
test.each(["abort", "identity"])(
  "%s cancels pending names-only transport and prevents late adoption",
  async (cause) => {
    const deferred = Promise.withResolvers<unknown>();
    transport = () => deferred.promise;
    const abort = new AbortController();
    const pending = readConfigKey(["CUSTOM_A", "CUSTOM_B"], abort.signal);
    await Promise.resolve();
    expect(calls[0]!.request.input).toEqual({
      keys: ["CUSTOM_A", "CUSTOM_B"],
    });
    if (cause === "abort") abort.abort();
    else invalidateClientLifetime();
    expect(calls[0]!.signal.aborted).toBe(true);
    deferred.resolve(response(calls[0]!.request));
    expect(await pending).toEqual({ status: "unavailable" });
  }
);
test("adopted result expires on identity change", async () => {
  const result = await readConfigKey(["CUSTOM_A", "CUSTOM_B"], new AbortController().signal);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Missing ready fixture");
  expect(result.matches).toEqual([true, false]);
  expect(result.isCurrent()).toBe(true);
  invalidateClientLifetime();
  expect(result.isCurrent()).toBe(false);
});
test.each([
  "empty-names",
  "too-many-names",
  "already-aborted",
  "empty-name",
  "long-name",
  "duplicate-name",
])("%s is held before transport", async (failure) => {
  const abort = new AbortController();
  if (failure === "already-aborted") abort.abort();
  const names =
    failure === "empty-names"
      ? []
      : failure === "too-many-names"
        ? Array.from({ length: 65 }, (_, index) => `CUSTOM_${index}`)
        : failure === "empty-name"
          ? [" "]
          : failure === "long-name"
            ? ["x".repeat(257)]
            : failure === "duplicate-name"
              ? ["CUSTOM_A", "CUSTOM_A"]
              : ["CUSTOM_A"];
  expect(await readConfigKey(names, abort.signal)).toEqual({ status: "held" });
  expect(calls).toHaveLength(0);
});
test("transport refusal remains unavailable without a partial guessed answer", async () => {
  transport = async () => {
    throw new Error("synthetic refusal");
  };
  expect(await readConfigKey(["CUSTOM_A"], new AbortController().signal)).toEqual({
    status: "unavailable",
  });
});
