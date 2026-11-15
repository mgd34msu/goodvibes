/**
 * new-event-times.ts, the one rule both providers use to turn a new event's
 * start and end into what is sent.
 *
 *  - An all-day event with no end lasts one day (Google and Graph both need an
 *    end at a later midnight).
 *  - A timed event with no end ends when it starts.
 *  - A floating time ("09:00", no zone) is the owner's wall clock: it is sent
 *    with the owner's zone, never relabelled UTC.
 *  - A time with a named zone keeps it; a UTC time is sent as UTC.
 */

import type { EventDateTime } from './types.js';
import type { NewCalendarEvent } from './oauth-types.js';

/** A wall time and the zone it is read in. */
export interface ZonedWallTime {
  /** 'YYYY-MM-DDTHH:mm:ss', no offset. */
  readonly dateTime: string;
  readonly timeZone: string;
}

export type ResolvedEventTimes =
  | { readonly allDay: true; readonly startDate: string; readonly endDate: string }
  | { readonly allDay: false; readonly start: ZonedWallTime; readonly end: ZonedWallTime };

/** A new event whose times cannot be sent as given. */
export class NewEventTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewEventTimeError';
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/;

function nextDay(date: string): string {
  const match = DATE.exec(date);
  if (!match) throw new NewEventTimeError(`'${date}' is not a date (YYYY-MM-DD).`);
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return next.toISOString().slice(0, 10);
}

function zoned(dt: EventDateTime, ownerZone: string): ZonedWallTime {
  const wall = WALL.exec(dt.value);
  if (!wall?.[1]) throw new NewEventTimeError(`'${dt.value}' is not a date and time (YYYY-MM-DDTHH:mm:ss).`);
  if (dt.zone === 'utc') return { dateTime: wall[1], timeZone: 'UTC' };
  if (dt.zone === 'tzid' && dt.tzid) return { dateTime: wall[1], timeZone: dt.tzid };
  return { dateTime: wall[1], timeZone: ownerZone };
}

/** Resolve a new event's times. `ownerZone` is an IANA zone ('UTC' when unknown). */
export function resolveNewEventTimes(event: NewCalendarEvent, ownerZone: string): ResolvedEventTimes {
  const zone = ownerZone.trim().length > 0 ? ownerZone.trim() : 'UTC';
  if (event.start.kind === 'date') {
    if (event.end && event.end.kind !== 'date') {
      throw new NewEventTimeError('An all-day event needs an all-day end (a date), not a time.');
    }
    if (!DATE.test(event.start.value)) throw new NewEventTimeError(`'${event.start.value}' is not a date (YYYY-MM-DD).`);
    const endDate = event.end ? event.end.value : nextDay(event.start.value);
    if (endDate <= event.start.value) {
      throw new NewEventTimeError('An all-day event must end on a later date than it starts (the end date is exclusive).');
    }
    return { allDay: true, startDate: event.start.value, endDate };
  }
  if (event.end && event.end.kind === 'date') {
    throw new NewEventTimeError('A timed event needs a timed end, not a date.');
  }
  const start = zoned(event.start, zone);
  const end = event.end ? zoned(event.end, zone) : start;
  if (start.timeZone === end.timeZone && end.dateTime < start.dateTime) {
    throw new NewEventTimeError('The event must not end before it starts.');
  }
  return { allDay: false, start, end };
}
