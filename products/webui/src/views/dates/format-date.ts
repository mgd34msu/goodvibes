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
