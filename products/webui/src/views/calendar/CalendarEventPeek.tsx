/**
 * The event detail for a selected calendar event. Reads `calendar.events.get`,
 * which carries fields the summary list does not (uid, recurrence), a genuine
 * detail fetch, not a re-render of the row's own data. The caller owns the
 * query (so its pane or drawer can show the title) and hands it to
 * CalendarEventBody, which renders the facts and description.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { Button } from '../../components/ui';
import { EmptyState, Facts, DetailSection, SkeletonRows } from '../../components/data-view/DataView';
import { AlertCircle } from 'lucide-react';
import { isAllDayEvent } from './calendar-time';

export type CalendarEventDetailData = Awaited<ReturnType<typeof platformClient.operator.calendar.events.get>>;

export function useCalendarEventDetail(eventId: string, calendarId?: string): UseQueryResult<CalendarEventDetailData> {
  return useQuery({
    queryKey: ['calendar', 'event', eventId, calendarId ?? ''],
    enabled: Boolean(eventId),
    queryFn: () => platformClient.operator.calendar.events.get(eventId, calendarId),
  });
}

function formatRange(start: string, end: string): string {
  const from = new Date(start);
  const to = new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return `${start} to ${end}`;
  if (isAllDayEvent(start, end)) {
    // The end of an all-day event is the day after its last day.
    const dayOpts = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' } as const;
    const last = new Date(to.getTime() - 86_400_000);
    return last.getTime() > from.getTime()
      ? `${from.toLocaleDateString(undefined, dayOpts)} to ${last.toLocaleDateString(undefined, dayOpts)} (all day)`
      : `${from.toLocaleDateString(undefined, dayOpts)} (all day)`;
  }
  const day = { weekday: 'short', month: 'short', day: 'numeric' } as const;
  const time = { hour: 'numeric', minute: '2-digit' } as const;
  const sameDay = from.toDateString() === to.toDateString();
  return sameDay
    ? `${from.toLocaleDateString(undefined, day)}, ${from.toLocaleTimeString(undefined, time)} to ${to.toLocaleTimeString(undefined, time)}`
    : `${from.toLocaleString(undefined, { ...day, ...time })} to ${to.toLocaleString(undefined, { ...day, ...time })}`;
}

export function CalendarEventBody({ detail }: { detail: UseQueryResult<CalendarEventDetailData> }) {
  if (detail.isPending) return <SkeletonRows count={3} label="Loading event" />;

  if (detail.error) {
    return (
      <EmptyState
        icon={<AlertCircle />}
        title="Event failed to load"
        role="status"
        action={<Button variant="outline" onClick={() => void detail.refetch()}>Try again</Button>}
      >
        {formatError(detail.error)}
      </EmptyState>
    );
  }

  const event = detail.data;
  return (
    <div className="calendar-detail" data-testid="calendar-event-detail">
      <Facts
        items={[
          { label: 'When', value: formatRange(event.start, event.end) },
          { label: 'Location', value: event.location },
          { label: 'Attendees', value: event.attendees && event.attendees.length > 0 ? event.attendees.join(', ') : undefined },
          { label: 'Repeats', value: event.recurrence },
        ]}
      />
      {event.description && (
        <DetailSection title="Description">
          <p className="calendar-detail__description">{event.description}</p>
        </DetailSection>
      )}
      <p className="calendar-detail__uid">UID: {event.uid}</p>
    </div>
  );
}
