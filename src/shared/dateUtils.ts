// ============================================================================
// DATE UTILITIES - Centralized date formatting functions
// ============================================================================

/**
 * Generate a current ISO timestamp string
 *
 * @returns Current date/time in ISO 8601 format (e.g., "2024-01-15T10:30:00.000Z")
 *
 * @example
 * const timestamp = formatTimestamp();
 * // Returns something like "2024-01-15T10:30:00.000Z"
 */
export function formatTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Extract the date portion from an ISO timestamp
 *
 * @param date - Optional Date object (defaults to current date)
 * @returns Date string in YYYY-MM-DD format (e.g., "2024-01-15")
 *
 * @example
 * const today = getISODateString();
 * // Returns "2024-01-15"
 *
 * const specific = getISODateString(new Date(2024, 0, 15));
 * // Returns "2024-01-15"
 */
export function getISODateString(date?: Date): string {
  const d = date ?? new Date();
  const isoString = d.toISOString();
  // Format is always YYYY-MM-DDTHH:mm:ss.sssZ, so split is safe
  return isoString.slice(0, 10);
}

/**
 * Get the current date string in YYYY-MM-DD format
 *
 * @returns Today's date in YYYY-MM-DD format
 *
 * @example
 * const today = getTodayString();
 * // Returns "2024-01-15"
 */
export function getTodayString(): string {
  return getISODateString();
}
