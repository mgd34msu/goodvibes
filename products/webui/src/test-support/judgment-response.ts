/**
 * Shared fixtures for the names-only browser judgment readers: a well-formed
 * settled or held response envelope for a request, and the table of corruptions
 * every reader must fail closed on. One copy, so no reader is checked against a
 * weaker table than its twin.
 */

interface JudgmentRequestShape {
  readonly battery: string;
  readonly requestId: string;
  readonly input: { readonly keys: readonly string[] };
}

/** Matches alternate true/false, so correspondence by index is observable. */
export const alternatingMatches = (keys: readonly unknown[]): boolean[] => keys.map((_, index) => index % 2 === 0);

export function judgmentResponse(input: JudgmentRequestShape, matches: readonly boolean[], held = false) {
  return {
    protocolVersion: 1,
    batteryVersion: 1,
    battery: input.battery as string,
    requestId: input.requestId,
    status: held ? "held" : "settled",
    ...(held ? { reason: "uncertain" } : { value: { matches: [...matches] } }),
    outcome: held ? "confirm" : "act",
    readings: Object.fromEntries(
      matches.map((match, index) => [
        `key_${index}`,
        {
          kind: "yes-no",
          probability: held ? 0.5 : match ? 0.99 : 0.01,
          verdict: held ? "uncertain" : match ? "yes" : "no",
          outcome: held ? "confirm" : "act",
        },
      ])
    ),
    evidence: matches.map((_, index) => ({
      decisionId: `synthetic-${index}`,
      model: "fixture",
      requestedModel: "fixture",
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
    })),
  };
}

export type JudgmentResponse = ReturnType<typeof judgmentResponse>;

export const responseCorruptions: readonly [string, (raw: JudgmentResponse) => void][] = [
  [
    "array verdict cannot impersonate an explicit negative",
    (raw) => {
      Object.assign(raw.readings.key_1!, { verdict: ["no"] });
    },
  ],
  [
    "array verdict cannot impersonate an explicit positive",
    (raw) => {
      Object.assign(raw.readings.key_0!, { verdict: ["yes"] });
    },
  ],
  [
    "array outcome cannot impersonate act",
    (raw) => {
      Object.assign(raw.readings.key_1!, { outcome: ["act"] });
    },
  ],
  [
    "protocol",
    (raw) => {
      raw.protocolVersion = 2;
    },
  ],
  [
    "battery-version",
    (raw) => {
      raw.batteryVersion = 2;
    },
  ],
  [
    "battery",
    (raw) => {
      raw.battery = "webui.unknown-battery";
    },
  ],
  [
    "request",
    (raw) => {
      raw.requestId = crypto.randomUUID();
    },
  ],
  [
    "status",
    (raw) => {
      raw.status = "ready";
    },
  ],
  [
    "extra envelope field",
    (raw) => {
      Object.assign(raw, { secret: "synthetic-forbidden" });
    },
  ],
  [
    "missing reading",
    (raw) => {
      delete raw.readings.key_1;
    },
  ],
  [
    "extra reading",
    (raw) => {
      raw.readings.key_2 = { ...raw.readings.key_0! };
    },
  ],
  [
    "wrong reading kind",
    (raw) => {
      raw.readings.key_0!.kind = "choice";
    },
  ],
  [
    "extra reading field",
    (raw) => {
      Object.assign(raw.readings.key_0!, { confidence: 1 });
    },
  ],
  [
    "negative probability",
    (raw) => {
      raw.readings.key_0!.probability = -0.1;
    },
  ],
  [
    "overflow probability",
    (raw) => {
      raw.readings.key_0!.probability = 1.1;
    },
  ],
  [
    "NaN probability",
    (raw) => {
      raw.readings.key_0!.probability = NaN;
    },
  ],
  [
    "infinite probability",
    (raw) => {
      raw.readings.key_0!.probability = Infinity;
    },
  ],
  [
    "unknown verdict",
    (raw) => {
      raw.readings.key_0!.verdict = "maybe";
    },
  ],
  [
    "unknown outcome",
    (raw) => {
      raw.readings.key_0!.outcome = "allow";
    },
  ],
  [
    "uncertain act",
    (raw) => {
      raw.readings.key_0!.verdict = "uncertain";
    },
  ],
  [
    "compound outcome",
    (raw) => {
      raw.outcome = "confirm";
    },
  ],
  [
    "unsettled reading with value",
    (raw) => {
      raw.readings.key_0!.outcome = "confirm";
      raw.outcome = "confirm";
    },
  ],
  [
    "missing evidence",
    (raw) => {
      raw.evidence = [];
    },
  ],
  [
    "duplicate evidence identity",
    (raw) => {
      raw.evidence[1]!.decisionId = raw.evidence[0]!.decisionId;
    },
  ],
  [
    "empty evidence identity",
    (raw) => {
      raw.evidence[0]!.decisionId = " ";
    },
  ],
  [
    "empty model",
    (raw) => {
      raw.evidence[0]!.model = "";
    },
  ],
  [
    "empty requested model",
    (raw) => {
      raw.evidence[0]!.requestedModel = "";
    },
  ],
  [
    "negative latency",
    (raw) => {
      raw.evidence[0]!.latencyMs = -1;
    },
  ],
  [
    "invalid input usage",
    (raw) => {
      raw.evidence[0]!.usage.inputTokens = NaN;
    },
  ],
  [
    "invalid output usage",
    (raw) => {
      raw.evidence[0]!.usage.outputTokens = -1;
    },
  ],
  [
    "extra usage",
    (raw) => {
      Object.assign(raw.evidence[0]!.usage, { secret: "synthetic-forbidden" });
    },
  ],
  [
    "extra evidence",
    (raw) => {
      Object.assign(raw.evidence[0]!, { state: "synthetic-forbidden" });
    },
  ],
  [
    "match reading disagreement",
    (raw) => {
      Object.assign(raw, { value: { matches: [false, false] } });
    },
  ],
  [
    "missing match",
    (raw) => {
      Object.assign(raw, { value: { matches: [true] } });
    },
  ],
  [
    "extra match",
    (raw) => {
      Object.assign(raw, { value: { matches: [true, false, true] } });
    },
  ],
  [
    "extra value field",
    (raw) => {
      Object.assign("value" in raw ? raw.value : {}, { names: ["CUSTOM_A", "CUSTOM_B"] });
    },
  ],
];
