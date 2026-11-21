/** Validate a nonempty timezone. Configuration callers interpret an empty UTC sentinel separately. */
export function isValidTimezone(timezone: string): boolean {
  return timezone.trim().length > 0 && isKnownTimeZone(timezone);
}

/** Thrown for a zone name the runtime's tz database does not know. */
export class UnknownTimeZoneError extends Error {
  override readonly name = 'UnknownTimeZoneError';
  constructor(readonly timeZone: string) {
    super(`'${timeZone}' is not a time zone this runtime knows.`);
  }
}

/** One formatter per zone: building an Intl.DateTimeFormat costs far more than using one. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The offset of `timeZone` from UTC, in ms, at the UTC instant `utcMs`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(utcMs));
  const part = (type: string): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? '0');
  const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant at which `timeZone`'s wall clock reads `wallMs` (the wall
 * clock expressed as if it were UTC). Two passes settle the offset across a
 * DST boundary. Throws {@link UnknownTimeZoneError} for a zone this runtime
 * does not know.
 */
export function zonedWallClockToUtcMs(wallMs: number, timeZone: string): number {
  try {
    const first = wallMs - zoneOffsetMs(wallMs, timeZone);
    return wallMs - zoneOffsetMs(first, timeZone);
  } catch {
    throw new UnknownTimeZoneError(timeZone);
  }
}

/** The wall clock of `timeZone` at the UTC instant `utcMs`, expressed as if it were UTC. */
export function utcToZonedWallClockMs(utcMs: number, timeZone: string): number {
  try {
    return utcMs + zoneOffsetMs(utcMs, timeZone);
  } catch {
    throw new UnknownTimeZoneError(timeZone);
  }
}

/** True when the runtime knows `timeZone`. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    zoneFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}
