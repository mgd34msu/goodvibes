/** Validate a nonempty timezone. Configuration callers interpret an empty UTC sentinel separately. */
export function isValidTimezone(timezone: string): boolean {
  if (timezone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch { return false; }
}
