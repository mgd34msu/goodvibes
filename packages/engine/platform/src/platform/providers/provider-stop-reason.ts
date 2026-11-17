/**
 * Build the providerStopReason spread for ChatResponse.
 * Returns { providerStopReason } when the raw value is known, otherwise {}.
 */
export function withProviderStopReason(
  rawStopReason: string | undefined,
): { providerStopReason?: string } {
  return rawStopReason !== undefined ? { providerStopReason: rawStopReason } : {};
}
