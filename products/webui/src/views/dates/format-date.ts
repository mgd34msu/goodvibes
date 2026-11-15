import { parseIsoDate } from '../../components/ui/DateField';

/**
 * A date for display. A bare `YYYY-MM-DD` is a calendar date with no zone, so
 * it is read as a local date: `new Date('2026-12-25')` is midnight UTC and
 * would print the 24th west of UTC. A full timestamp is an instant and is
 * shown in the viewer's zone.
 */
export function formatDateOnly(iso: string | null): string {
  if (!iso) return 'No date';
  const options = { month: 'short', day: 'numeric', year: 'numeric' } as const;
  const dateOnly = parseIsoDate(iso);
  if (dateOnly) return dateOnly.toLocaleDateString(undefined, options);
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString(undefined, options);
}

/**
 * A date as an occasion records it: `MM-DD` for a date that recurs with no
 * year, or `YYYY-MM-DD`. Anything else is shown as written.
 */
export function recordedDateLabel(recorded: string): string {
  const monthDay = /^(\d{2})-(\d{2})$/.exec(recorded);
  if (monthDay) {
    const date = new Date(2000, Number(monthDay[1]) - 1, Number(monthDay[2]));
    return Number.isNaN(date.getTime()) ? recorded : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(recorded) ? formatDateOnly(recorded) : recorded;
}
