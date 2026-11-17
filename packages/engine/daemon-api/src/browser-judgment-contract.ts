/** Closed browser judgment protocol. No prompt, model, route, or credential input. */
export const BROWSER_JUDGMENT_PROTOCOL_VERSION = 1;
export const BROWSER_JUDGMENT_PATH = '/api/judgment/batteries/run';
/**
 * The batteries a browser may run. The command palette, code-block language,
 * settings key classification, credential-to-provider highlight and read-aloud
 * speech seams are decided in the browser by code; a request naming one of
 * their former ids is refused with JUDGMENT_BATTERY_UNKNOWN.
 */
export const BROWSER_JUDGMENT_BATTERY_IDS = [
  'webui.models.catalog-provider-match',
] as const;
export type BrowserJudgmentBatteryId = typeof BROWSER_JUDGMENT_BATTERY_IDS[number];
/** Wire binding versions. */
export const BROWSER_JUDGMENT_BATTERY_VERSIONS = Object.freeze({
  'webui.models.catalog-provider-match': 1,
} as const satisfies Readonly<Record<BrowserJudgmentBatteryId, number>>);
export type BrowserJudgmentBatteryVersion<K extends BrowserJudgmentBatteryId = BrowserJudgmentBatteryId> = typeof BROWSER_JUDGMENT_BATTERY_VERSIONS[K];
export interface BrowserJudgmentInputMap {
  'webui.models.catalog-provider-match': { readonly providerId: string; readonly keys: readonly string[] };
}
export interface BrowserJudgmentValueMap {
  'webui.models.catalog-provider-match': { readonly matches: readonly boolean[] };
}
export type BrowserJudgmentRequest<K extends BrowserJudgmentBatteryId = BrowserJudgmentBatteryId> = K extends BrowserJudgmentBatteryId ? {
  readonly protocolVersion: 1; readonly requestId: string; readonly battery: K; readonly batteryVersion: BrowserJudgmentBatteryVersion<K>;
  readonly input: BrowserJudgmentInputMap[K];
} : never;

/** Operational budgets, never meaning/confidence thresholds. */
export const BROWSER_JUDGMENT_LIMITS = Object.freeze({
  bodyBytes: 64 * 1024, bodyMs: 5_000, depth: 16, nodes: 4_096, textChars: 32_768,
  arrayItems: 128, referenceChars: 256,
  closeMs: 5_000, principalRuns: 4, totalRuns: 16, callsPerRun: 64,
});

const REFUSALS = {
  JUDGMENT_INVALID_INPUT: [400, 'The judgment request does not match its closed schema.'],
  JUDGMENT_BATTERY_UNKNOWN: [404, 'This browser judgment battery is not known.'],
  JUDGMENT_PROTOCOL_VERSION_UNSUPPORTED: [409, 'This judgment protocol version is not supported.'],
  JUDGMENT_BATTERY_VERSION_UNSUPPORTED: [409, 'This judgment battery version is not supported.'],
  JUDGMENT_INPUT_TOO_LARGE: [413, 'The judgment input exceeds its bounded input limit.'],
  JUDGMENT_CONTENT_TYPE_UNSUPPORTED: [415, 'Judgment requests require application/json.'],
  JUDGMENT_INPUT_HELD: [422, 'Protected or unsupported input was held before judgment.'],
  JUDGMENT_REFERENCE_HELD: [422, 'The judgment source is unavailable, expired, changed, or inaccessible.'],
  JUDGMENT_PERMISSION_HELD: [403, 'This source is not authorized for the configured judgment route.'],
  JUDGMENT_AUTH_REQUIRED: [401, 'Operator authentication is required.'],
  JUDGMENT_ACCESS_DENIED: [403, 'The authenticated operator lacks judgment access.'],
  JUDGMENT_ORIGIN_DENIED: [403, 'This request origin is not authorized.'],
  JUDGMENT_BUSY: [429, 'The judgment service is at its concurrent request limit.'],
  JUDGMENT_UNAVAILABLE: [503, 'No decision models are currently available. Check API keys, endpoint addresses, model names and local model services, then retry. The operation has stopped.'],
  JUDGMENT_NO_DECISION_MODEL: [503, 'No decision model is in use. This semantic reading is disabled; use the feature\'s path without a decision model.'],
  JUDGMENT_SHUTTING_DOWN: [503, 'The judgment service is shutting down.'],
  JUDGMENT_INVALID_RESPONSE: [502, 'The judgment result did not match its registered contract.'],
  JUDGMENT_INTERNAL: [500, 'The decision client failed internally. The operation has stopped.'],
  JUDGMENT_UNRECORDED: [500, 'The judgment could not be recorded and must not be used.'],
  JUDGMENT_ABORTED: [499, 'The judgment request was cancelled.'],
  JUDGMENT_DEADLINE: [504, 'The judgment request exceeded its deadline.'],
} as const;
export type BrowserJudgmentErrorCode = keyof typeof REFUSALS;

/** Only fixed, value-free messages cross this boundary. Never pass Error.message. */
export class BrowserJudgmentError extends Error {
  readonly status: number;
  constructor(readonly code: BrowserJudgmentErrorCode) {
    super(REFUSALS[code][1]); this.name = 'BrowserJudgmentError'; this.status = REFUSALS[code][0];
  }
}
export function browserJudgmentRefusal(error: unknown): { readonly status: number; readonly body: object } {
  let code: BrowserJudgmentErrorCode = 'JUDGMENT_INTERNAL';
  if (error instanceof BrowserJudgmentError) {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    const candidate: unknown = descriptor?.value;
    if (typeof candidate === 'string' && Object.hasOwn(REFUSALS, candidate)) code = candidate as BrowserJudgmentErrorCode;
  }
  // Even a real Error instance can have its message/status replaced by another layer.
  return { status: REFUSALS[code][0], body: { protocolVersion: 1, status: 'held', error: { code, message: REFUSALS[code][1] } } };
}
