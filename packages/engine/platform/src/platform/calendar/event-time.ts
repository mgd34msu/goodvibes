/**
 * event-time.ts, the one answer to "what instant is this EventDateTime".
 *
 *  - `kind: 'date'` (all-day) is midnight UTC of that date.
 *  - `zone: 'utc'` is the instant it names.
 *  - `zone: 'tzid'` is converted through the runtime's zone data
 *    (`zonedWallClockToUtcMs`), the same conversion the CalDAV reader uses, so
 *    09:00 America/Los_Angeles sorts after 10:00Z, as it happens.
 *  - `zone: 'floating'` (RFC 5545 §3.3.5: the observer's own wall clock) is read
 *    in this runtime's local zone, the same rule the CalDAV reader applies
 *    (`parseICalDate`). A TZID the runtime does not know is read the same way.
 */

import { zonedWallClockToUtcMs } from './caldav-ics.js';
import type { EventDateTime } from './types.js';

const DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

/** The wall clock of a date-time value, expressed as if it were UTC; NaN when unreadable. */
export function wallClockMs(value: string): number {
  const m = WALL.exec(value);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/** The instant a floating wall clock reads in this runtime's local zone; NaN when unreadable. */
function localWallClockMs(value: string): number {
  const m = WALL.exec(value);
  if (!m) return Number.NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

/** Epoch ms of one EventDateTime; see the module header for each kind. */
export function eventDateTimeEpochMs(dt: EventDateTime): number {
  if (dt.kind === 'date') {
    const m = DATE.exec(dt.value);
    if (!m) return Number.NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  if (dt.zone === 'utc') {
    const ms = Date.parse(dt.value);
    if (Number.isFinite(ms)) return ms;
  }
  if (dt.zone === 'tzid' && dt.tzid) {
    const wall = wallClockMs(dt.value);
    if (Number.isFinite(wall)) {
      try {
        return zonedWallClockToUtcMs(wall, dt.tzid);
      } catch {
        return localWallClockMs(dt.value);
      }
    }
  }
  return localWallClockMs(dt.value);
}
