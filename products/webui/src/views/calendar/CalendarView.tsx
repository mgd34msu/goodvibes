/**
 * Calendar, the Calendar tab of Personal. Events (list/get/create) and ICS
 * import/export over the daemon's CalDAV-backed `calendar.*` verbs. Calendar is
 * a daemon/agent feature with no TUI command surface, the web UI is its first
 * screen.
 *
 * Layout: an agenda grouped by day (list) with the selected event's detail in
 * the right pane, or a month grid with the detail in a drawer. The Segmented
 * "Agenda / Month" in the filter row switches between them. "New event" is the
 * tab's one primary action; .ics export and import live in the "More" menu.
 *
 * HONESTY CONTRACT (three refusal shapes, each rendered distinctly, never folded
 * into a generic "error"):
 *  1. UNCONFIGURED, the daemon's 412 CALENDAR_NOT_CONFIGURED / CALENDAR_CREDENTIALS_MISSING.
 *     The operator has not brought their own CalDAV endpoint. Neutral, not a
 *     fault: a pointer to the config keys (`surfaces.calendar.caldavUrl` /
 *     `caldavUser` / `caldavPassword`) and one action that opens settings.
 *  2. NOT AVAILABLE, a 404 "unknown gateway method" or 501 "not invokable" refusal:
 *     this daemon build has no live calendar handler wired at all. Distinct from
 *     "unconfigured": the CAPABILITY itself is missing, not just its configuration.
 *  3. GENUINE ERROR, anything else (network failure, a malformed range, a CalDAV
 *     auth failure against a configured endpoint), an empty state with retry.
 * Never fabricate a fourth "it's just empty" reading for any of the three above.
 */
import { SyntheticEvent, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import { client as platformClient } from '../../lib/goodvibes';
import type { CalendarEventCreateInput, CalendarIcsImportInput } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import {
  errorCode,
  formatError,
  isCalendarAuthFailedError,
  isCalendarUnconfiguredError,
  isMethodNotInvokableError,
  isMethodUnavailableError,
} from '../../lib/errors';
import ErrorBoundary from '../../components/feedback/ErrorBoundary';
import { DetailPane, EmptyState, RowGroup, SkeletonRows, ListDetail } from '../../components/data-view/DataView';
import {
  Button,
  Dialog,
  Drawer,
  Field,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Row,
  Segmented,
  Sheet,
  Textarea,
  useConfirm,
  useMediaQuery,
  PHONE_QUERY,
} from '../../components/ui';
import { DateField, parseIsoDate, toIsoDate, monthGrid } from '../../components/ui/DateField';
import { PersonalNotice, PersonalPage } from '../personal/PersonalPage';
import { openSettingsSection } from '../personal/openSettings';
import { CalendarEventBody, useCalendarEventDetail, type CalendarEventDetailData } from './CalendarEventPeek';
import { CalendarMonth } from './CalendarMonth';
import { allDayFlagOf, eventDayKey, eventTimeLabel, localDateOffset, localDayEndIso, localDayStartIso } from './calendar-time';
import '../../styles/components/calendar.css';

type CalendarLayout = 'agenda' | 'month';

function splitAttendees(value: string): string[] | undefined {
  const list = value.split(',').map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function downloadIcs(icsContent: string, filename: string): void {
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

interface CalendarNote {
  title: string;
  description: string;
  /** Settings section that fixes it, when settings can. */
  settings?: string;
}

/** Classify a calendar-surface error into one of the three honest outcomes. Returns
 * null for a genuine error (the caller falls back to a plain retry state). */
/** An ISO instant as the local `YYYY-MM-DDTHH:MM` a time DateField holds. */
function localDateTimeValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${toIsoDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function unconfiguredNote(error: unknown): CalendarNote | null {
  if (isCalendarUnconfiguredError(error)) {
    return {
      title: 'Calendar isn’t configured',
      description: 'Add your calendar in Settings and your events show up here.',
      settings: 'all',
    };
  }
  if (isMethodUnavailableError(error) || isMethodNotInvokableError(error)) {
    return {
      title: 'Calendar isn’t available on this daemon yet',
      description: 'This daemon has no calendar service yet, and updating the daemon turns it on.',
      settings: 'about',
    };
  }
  if (isCalendarAuthFailedError(error)) {
    return {
      title: 'The calendar server refused the saved password',
      description: 'Replace the calendar password in Settings and your events show up here.',
      settings: 'all',
    };
  }
  return null;
}

function dayLabel(key: string): string {
  const date = parseIsoDate(key);
  if (!date) return key;
  const today = new Date();
  const todayKey = toIsoDate(today);
  const tomorrowKey = toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  const text = date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  if (key === todayKey) return `Today, ${text}`;
  if (key === tomorrowKey) return `Tomorrow, ${text}`;
  return text;
}

/**
 * The phone's one date-range button: "Oct 1 – 15" inside one month, "Sep 28 –
 * Oct 5" across months, with the year only when the range leaves this year.
 */
export function formatRangeLabel(from: string, to: string, now: Date = new Date()): string {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (!start && !end) return 'Any date';
  const year = now.getFullYear();
  const withYear = (start !== null && start.getFullYear() !== year) || (end !== null && end.getFullYear() !== year);
  const fmt = (date: Date, opts: Intl.DateTimeFormatOptions) => date.toLocaleDateString('en-US', opts);
  const monthDay: Intl.DateTimeFormatOptions = withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' };
  if (!end) return start ? `From ${fmt(start, monthDay)}` : 'Any date';
  if (!start) return `Until ${fmt(end, monthDay)}`;
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    if (start.getDate() === end.getDate()) return fmt(start, monthDay);
    const head = fmt(start, { month: 'short', day: 'numeric' });
    return withYear ? `${head} – ${end.getDate()}, ${end.getFullYear()}` : `${head} – ${end.getDate()}`;
  }
  return `${fmt(start, monthDay)} – ${fmt(end, monthDay)}`;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export interface CalendarViewProps {
  /** The Personal tab switcher; shown first in the filter row. */
  tabs?: ReactNode;
}

export function CalendarView({ tabs }: CalendarViewProps = {}) {
  const queryClient = useQueryClient();
  const phone = useMediaQuery(PHONE_QUERY);
  const [rangeOpen, setRangeOpen] = useState(false);

  const [layout, setLayout] = useState<CalendarLayout>('agenda');
  const [from, setFrom] = useState(() => localDateOffset(0));
  const [to, setTo] = useState(() => localDateOffset(14));
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  // The typed calendar id is a draft; the calendar the view reads (one CalDAV
  // REPORT per change) is committed on Enter or when the field loses focus.
  const [calendarDraft, setCalendarDraft] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const commitCalendar = () => setCalendarId(calendarDraft.trim());
  const [selectedId, setSelectedId] = useState('');

  const [newOpen, setNewOpen] = useState(false);
  // The event the form changes; '' while it creates a new one.
  const [editingId, setEditingId] = useState('');
  // The start and end the edit form opened with: times are sent only when changed, so editing
  // the title of an all-day event keeps it all-day.
  const [editingTimes, setEditingTimes] = useState({ start: '', end: '' });
  // The calendar's version of the event when the form opened: a save over a newer version is refused, not written over it.
  const [editingRevision, setEditingRevision] = useState<string | undefined>(undefined);
  const confirm = useConfirm();
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [attendees, setAttendees] = useState('');

  const [importOpen, setImportOpen] = useState(false);
  const [icsContent, setIcsContent] = useState('');

  const [notice, setNotice] = useState<{ tone?: 'bad'; body: ReactNode } | null>(null);

  const monthDays = useMemo(() => monthGrid(month), [month]);
  const rangeFromDate = layout === 'month' ? toIsoDate(monthDays[0]) : from;
  const rangeToDate = layout === 'month' ? toIsoDate(monthDays[monthDays.length - 1]) : to;
  const rangeFrom = localDayStartIso(rangeFromDate);
  const rangeTo = localDayEndIso(rangeToDate);
  const calendarFilter = calendarId.trim();

  // The daemon caps a page at 200, so a larger ask would never read as full.
  const eventLimit = layout === 'month' ? 200 : 100;
  const events = useQuery({
    queryKey: queryKeys.calendarEvents(rangeFrom, rangeTo, calendarId),
    queryFn: () => platformClient.operator.calendar.events.list({
      from: rangeFrom || undefined,
      to: rangeTo || undefined,
      ...(calendarFilter ? { calendarId: calendarFilter } : {}),
      limit: eventLimit,
    }),
  });

  const detail = useCalendarEventDetail(selectedId, calendarFilter || undefined);

  // The calendars the account can reach, offered as choices for the calendar
  // field: one request per page open, in place of guessing an id.
  const calendars = useQuery({
    queryKey: ['calendar', 'calendars'],
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: () => platformClient.operator.invoke('calendar.calendars.list', {}),
  });
  const calendarChoices = useMemo(() => {
    const list = (calendars.data as { calendars?: unknown } | undefined)?.calendars;
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry: unknown) => {
      const record = (typeof entry === 'object' && entry !== null ? entry : {}) as { calendarId?: unknown; displayName?: unknown };
      return typeof record.calendarId === 'string' && record.calendarId
        ? [{ calendarId: record.calendarId, displayName: typeof record.displayName === 'string' ? record.displayName : record.calendarId }]
        : [];
    });
  }, [calendars.data]);
  const calendarListId = 'calendar-choices';

  const create = useMutation({
    mutationFn: async () => {
      if (editingId) {
        // Attendees come back as display names, so the guest list is only sent
        // when addresses were typed; otherwise the invited guests stay.
        const timesChanged = start !== editingTimes.start || end !== editingTimes.end;
        await platformClient.operator.invoke('calendar.events.update', {
          eventId: editingId,
          title: title.trim(),
          ...(timesChanged ? { start: new Date(start).toISOString(), end: new Date(end).toISOString() } : {}),
          location: location.trim(),
          description: description.trim(),
          ...(splitAttendees(attendees) ? { attendees: splitAttendees(attendees) } : {}),
          ...(calendarFilter ? { calendarId: calendarFilter } : {}),
          ...(editingRevision ? { expectedRevision: editingRevision } : {}),
          confirm: true,
        });
        return 'Event updated.';
      }
      const input: CalendarEventCreateInput = {
        title: title.trim(),
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        confirm: true,
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(splitAttendees(attendees) ? { attendees: splitAttendees(attendees) } : {}),
        ...(calendarFilter ? { calendarId: calendarFilter } : {}),
      };
      const result = await platformClient.operator.calendar.events.create(input);
      return `Event created (id ${result.eventId}).`;
    },
    onSuccess: async (message) => {
      closeEventForm();
      setNotice({ body: message });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'events'] });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'event'] });
    },
    onError: async (error) => {
      // Changed elsewhere since the form opened: nothing was written. The form closes and the
      // event is shown as it is now, so the change can be made again on the current version.
      if (errorCode(error) !== 'CALENDAR_EVENT_CHANGED') return;
      closeEventForm();
      setNotice({ tone: 'bad', body: 'Not saved: this event was changed on the calendar after you opened it. It is shown as it is now; make your change again.' });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'events'] });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'event'] });
    },
  });

  const removeEvent = useMutation({
    mutationFn: (eventId: string) => platformClient.operator.invoke('calendar.events.delete', {
      eventId,
      ...(calendarFilter ? { calendarId: calendarFilter } : {}),
      confirm: true,
    }),
    onSuccess: async (result) => {
      setSelectedId('');
      const deleted = typeof result === 'object' && result !== null && (result as { deleted?: unknown }).deleted === true;
      setNotice({ body: deleted ? 'Event deleted.' : 'The calendar no longer held that event.' });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'events'] });
    },
    onError: (error) => setNotice({ tone: 'bad', body: `Delete failed: ${formatError(error)}` }),
  });

  function closeEventForm(): void {
    setTitle('');
    setStart('');
    setEnd('');
    setLocation('');
    setDescription('');
    setAttendees('');
    setEditingId('');
    setEditingRevision(undefined);
    setNewOpen(false);
  }

  function openNewEvent(): void {
    closeEventForm();
    create.reset();
    setNewOpen(true);
  }

  function openEditEvent(event: CalendarEventDetailData): void {
    create.reset();
    setEditingId(event.id);
    const revision = (event as { readonly revision?: unknown }).revision;
    setEditingRevision(typeof revision === 'string' && revision ? revision : undefined);
    setTitle(event.title);
    setStart(localDateTimeValue(event.start));
    setEnd(localDateTimeValue(event.end));
    setEditingTimes({ start: localDateTimeValue(event.start), end: localDateTimeValue(event.end) });
    setLocation(event.location ?? '');
    setDescription(event.description ?? '');
    setAttendees('');
    setNewOpen(true);
  }

  // Removing an event from the owner's own calendar cannot be undone here, so it asks once.
  async function askRemoveEvent(event: CalendarEventDetailData): Promise<void> {
    const ok = await confirm.ask({
      title: 'Delete this event?',
      target: event.title,
      description: 'It is removed from your calendar, and guests are told by the calendar.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (ok) removeEvent.mutate(event.id);
  }

  const eventActions = detail.data ? (
    <div className="calendar-detail__actions">
      <Button variant="outline" size="sm" onClick={() => detail.data && openEditEvent(detail.data)}>Edit</Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={removeEvent.isPending}
        onClick={() => { if (detail.data) void askRemoveEvent(detail.data); }}
      >
        {removeEvent.isPending ? 'Deleting…' : 'Delete'}
      </Button>
    </div>
  ) : null;

  const exportIcs = useMutation({
    mutationFn: () => platformClient.operator.calendar.ics.export({
      from: rangeFrom || undefined,
      to: rangeTo || undefined,
      ...(calendarFilter ? { calendarId: calendarFilter } : {}),
    }),
    onSuccess: (result) => {
      downloadIcs(result.icsContent, `calendar-export-${rangeFromDate}-to-${rangeToDate}.ics`);
      setNotice({ body: `Exported ${String(result.eventCount)} event(s).` });
    },
    onError: (error) => {
      const note = unconfiguredNote(error);
      setNotice({ tone: 'bad', body: note ? `${note.title}. ${note.description}` : `Export failed: ${formatError(error)}` });
    },
  });

  const importIcs = useMutation({
    mutationFn: () => {
      const input: CalendarIcsImportInput = {
        icsContent,
        confirm: true,
        ...(calendarFilter ? { calendarId: calendarFilter } : {}),
      };
      return platformClient.operator.calendar.ics.import(input);
    },
    onSuccess: async (result) => {
      setIcsContent('');
      setImportOpen(false);
      setNotice({
        body: (
          <div>
            <p>Imported {result.imported} event(s).</p>
            {result.errors.length > 0 && (
              <ul className="calendar-notice__errors">
                {result.errors.map((message, index) => <li key={index}>{message}</li>)}
              </ul>
            )}
          </div>
        ),
      });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'events'] });
    },
  });

  const items = events.data?.events;
  const sortedItems = useMemo(() => [...(items ?? [])].sort((a, b) => a.start.localeCompare(b.start)), [items]);
  const groups = useMemo(() => {
    const map = new Map<string, typeof sortedItems>();
    for (const item of sortedItems) {
      const key = eventDayKey(item.start, item.end, allDayFlagOf(item));
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()];
  }, [sortedItems]);
  const honestNote = events.error ? unconfiguredNote(events.error) : null;
  const createNote = create.error ? unconfiguredNote(create.error) : null;
  const importNote = importIcs.error ? unconfiguredNote(importIcs.error) : null;
  const working = !events.isPending && !events.error;

  function submitCreate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (title.trim() && start && end) create.mutate();
  }

  function submitImport(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (icsContent.trim()) importIcs.mutate();
  }

  function changeLayout(next: CalendarLayout) {
    setLayout(next);
    setSelectedId('');
  }

  function shiftMonth(delta: number) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
    setSelectedId('');
  }

  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const shortMonthLabel = month.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

  const layoutToggle = (
    <Segmented<CalendarLayout>
      label="Calendar layout"
      className="calendar-layout-toggle"
      value={layout}
      options={[{ value: 'agenda', label: 'Agenda' }, { value: 'month', label: 'Month' }]}
      onChange={changeLayout}
    />
  );

  const goToday = () => {
    setMonth(startOfMonth(new Date()));
    setSelectedId('');
  };

  const moreMenu = (
    <Menu
      label="More calendar actions"
      placement="bottom-end"
      trigger={(props) => <IconButton label="More calendar actions" icon={<MoreHorizontal />} {...props} />}
    >
      {phone && <MenuItem icon={<RefreshCw />} onSelect={() => void events.refetch()}>Refresh events</MenuItem>}
      {phone && layout === 'month' && <MenuItem onSelect={goToday}>Go to this month</MenuItem>}
      {phone && <MenuSeparator />}
      <MenuItem onSelect={() => exportIcs.mutate()} disabled={exportIcs.isPending || !working}>Export range as .ics</MenuItem>
      <MenuItem onSelect={() => setImportOpen(true)} disabled={Boolean(honestNote)}>Import .ics file content</MenuItem>
    </Menu>
  );

  const monthNav = (
    <div className="calendar-month-nav">
      <IconButton label="Previous month" icon={<ChevronLeft />} onClick={() => shiftMonth(-1)} />
      <span className="calendar-month-nav__label" aria-live="polite">{phone ? shortMonthLabel : monthLabel}</span>
      <IconButton label="Next month" icon={<ChevronRight />} onClick={() => shiftMonth(1)} />
      {!phone && (
        <Button variant="ghost" size="sm" onClick={goToday}>
          Today
        </Button>
      )}
    </div>
  );

  const rangeLabel = formatRangeLabel(from, to);
  const calendarLabel = calendarFilter || 'Default calendar';

  // Phone: one compact row (layout toggle, one date-range button, the more menu),
  // so the agenda starts near the top of the screen. The range and the calendar
  // choice live in a sheet.
  const filters = phone ? (
    <div className="calendar-phone-controls">
      {layoutToggle}
      {layout === 'agenda' ? (
        <Button
          variant="outline"
          className="calendar-range-button"
          icon={<CalendarDays aria-hidden="true" />}
          onClick={() => setRangeOpen(true)}
          aria-label={`Date range ${rangeLabel}, ${calendarLabel}. Change`}
          aria-haspopup="dialog"
        >
          <span className="calendar-range-button__text">{rangeLabel}</span>
        </Button>
      ) : monthNav}
      {moreMenu}
    </div>
  ) : (
    <>
      {layoutToggle}
      {layout === 'agenda' ? (
        <>
          <DateField value={from} onChange={setFrom} aria-label="Range start" />
          <DateField value={to} onChange={setTo} aria-label="Range end" />
        </>
      ) : monthNav}
      <Input
        className="calendar-filter-calendar"
        value={calendarDraft}
        onChange={(event) => setCalendarDraft(event.target.value)}
        onBlur={commitCalendar}
        onKeyDown={(event) => { if (event.key === 'Enter') commitCalendar(); }}
        placeholder="Default calendar"
        aria-label="Logical calendar id"
        list={calendarChoices.length ? calendarListId : undefined}
      />
      {calendarChoices.length > 0 && (
        <datalist id={calendarListId}>
          {calendarChoices.map((choice) => (
            <option key={choice.calendarId} value={choice.calendarId}>{choice.displayName}</option>
          ))}
        </datalist>
      )}
      <div className="dv-filters__end">
        <IconButton label="Refresh events" icon={<RefreshCw />} onClick={() => void events.refetch()} />
        {moreMenu}
      </div>
    </>
  );

  const action = honestNote
    ? undefined
    : <Button variant="primary" icon={<Plus />} onClick={openNewEvent}>New event</Button>;

  const truncated = (events.data?.events.length ?? 0) >= eventLimit;
  const noticeNode = (
    <>
      {notice ? <PersonalNotice tone={notice.tone}>{notice.body}</PersonalNotice> : null}
      {truncated ? (
        <PersonalNotice tone="warn">
          Showing the first {eventLimit} events in this range. Narrow the dates to see the rest.
        </PersonalNotice>
      ) : null}
    </>
  );

  let content: ReactNode;
  if (events.isPending) {
    content = <SkeletonRows count={6} label="Loading events" />;
  } else if (honestNote) {
    content = (
      <EmptyState
        icon={<CalendarDays />}
        title={honestNote.title}
        role="status"
        action={honestNote.settings
          ? <Button variant="outline" onClick={() => openSettingsSection(honestNote.settings ?? 'general')}>
              {honestNote.settings === 'about' ? 'Update daemon' : 'Open settings'}
            </Button>
          : undefined}
      >
        {honestNote.description}
      </EmptyState>
    );
  } else if (events.error) {
    content = (
      <EmptyState
        icon={<AlertCircle />}
        title="Events failed to load"
        role="status"
        action={<Button variant="outline" onClick={() => void events.refetch()}>Try again</Button>}
      >
        {formatError(events.error)}
      </EmptyState>
    );
  } else if (layout === 'month') {
    content = (
      <>
        {noticeNode}
        <CalendarMonth month={month} events={sortedItems} selectedId={selectedId} onSelect={setSelectedId} />
      </>
    );
  } else if (sortedItems.length === 0) {
    content = (
      <>
        {noticeNode}
        <EmptyState
          icon={<CalendarDays />}
          title="No events in this range"
          action={<Button variant="outline" onClick={openNewEvent}>New event</Button>}
        >
          Try a wider date range, or add the first event.
        </EmptyState>
      </>
    );
  } else {
    const list = (
      <>
        {noticeNode}
        <div data-testid="calendar-agenda">
          {groups.map(([key, dayItems]) => (
            <RowGroup key={key} label={dayLabel(key)} count={dayItems.length}>
              {dayItems.map((item) => (
                <Row
                  key={item.id}
                  className="calendar-event-row"
                  title={item.title}
                  meta={item.location}
                  selected={item.id === selectedId}
                  onSelect={() => setSelectedId(item.id)}
                  trailing={<span className="dv-value">{eventTimeLabel(item.start, item.end, allDayFlagOf(item))}</span>}
                />
              ))}
            </RowGroup>
          ))}
        </div>
      </>
    );
    content = (
      <ListDetail
        mode="peek"
        list={list}
        detailOpen={Boolean(selectedId)}
        onCloseDetail={() => setSelectedId('')}
        listLabel="Events"
        detailLabel="Event detail"
        backLabel="All events"
        detail={(
          <DetailPane title={detail.data?.title ?? 'Event'} onClose={() => setSelectedId('')} closeLabel="Close event">
            <CalendarEventBody detail={detail} />
            {eventActions}
          </DetailPane>
        )}
      />
    );
  }

  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <EmptyState icon={<AlertCircle />} title="Calendar view failed" action={<Button variant="outline" onClick={reset}>Try again</Button>}>
          {formatError(err)}
        </EmptyState>
      )}
    >
      <PersonalPage tabs={tabs} filters={filters} action={action}>
        {content}
      </PersonalPage>

      <Drawer
        open={layout === 'month' && Boolean(selectedId)}
        onClose={() => setSelectedId('')}
        label="Event detail"
        title={detail.data?.title ?? 'Event'}
      >
        <div className="calendar-drawer-body">
          <CalendarEventBody detail={detail} />
          {eventActions}
        </div>
      </Drawer>

      <Sheet open={phone && rangeOpen} onClose={() => setRangeOpen(false)} label="Date range">
        <div className="calendar-range-sheet">
          <h2 className="calendar-range-sheet__title">Date range</h2>
          <div className="personal-form__split">
            <Field label="From">
              <DateField value={from} onChange={setFrom} aria-label="Range start" />
            </Field>
            <Field label="To">
              <DateField value={to} onChange={setTo} aria-label="Range end" />
            </Field>
          </div>
          <Field label="Calendar" help="Leave empty for the default calendar.">
            <Input
              value={calendarDraft}
              onChange={(event) => setCalendarDraft(event.target.value)}
              onBlur={commitCalendar}
              onKeyDown={(event) => { if (event.key === 'Enter') commitCalendar(); }}
              placeholder="Default calendar"
              aria-label="Logical calendar id"
              list={calendarChoices.length ? calendarListId : undefined}
            />
          </Field>
          <Button variant="primary" className="calendar-range-sheet__done" onClick={() => { commitCalendar(); setRangeOpen(false); }}>Done</Button>
        </div>
      </Sheet>

      {confirm.element}
      <Dialog
        open={newOpen}
        onClose={closeEventForm}
        title={editingId ? 'Edit event' : 'New event'}
        footer={(
          <>
            <Button variant="secondary" onClick={closeEventForm}>Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              form="calendar-new-event"
              disabled={create.isPending || !title.trim() || !start || !end}
              aria-busy={create.isPending}
            >
              {create.isPending ? (editingId ? 'Saving…' : 'Creating…') : (editingId ? 'Save changes' : 'Create event')}
            </Button>
          </>
        )}
      >
        <form id="calendar-new-event" className="personal-form" onSubmit={submitCreate}>
          <Field label="Title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </Field>
          <div className="personal-form__split">
            <Field label="Start">
              <DateField time value={start} onChange={setStart} required />
            </Field>
            <Field label="End">
              <DateField time value={end} onChange={setEnd} required />
            </Field>
          </div>
          <Field label="Location">
            <Input value={location} onChange={(event) => setLocation(event.target.value)} />
          </Field>
          <Field label="Description">
            <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
          </Field>
          <Field
            label="Attendees"
            help={editingId
              ? 'Leave empty to keep the guests already invited; addresses typed here replace them.'
              : 'Separate addresses with commas.'}
          >
            <Input value={attendees} onChange={(event) => setAttendees(event.target.value)} />
          </Field>
          {createNote ? (
            <div className="dv-notice" role="status"><span>{createNote.title}. {createNote.description}</span></div>
          ) : create.error ? (
            <div className="dv-notice dv-notice--bad" role="alert"><AlertCircle aria-hidden="true" /><span>{editingId ? 'Save failed' : 'Create failed'}: {formatError(create.error)}</span></div>
          ) : null}
        </form>
      </Dialog>

      <Dialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import .ics content"
        description="Paste iCalendar text. Every event in it is added to the calendar."
        footer={(
          <>
            <Button variant="secondary" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              form="calendar-import"
              disabled={importIcs.isPending || !icsContent.trim()}
              aria-busy={importIcs.isPending}
            >
              {importIcs.isPending ? 'Importing…' : 'Import'}
            </Button>
          </>
        )}
      >
        <form id="calendar-import" className="personal-form" onSubmit={submitImport}>
          <Field label="iCalendar content">
            <Textarea
              className="calendar-ics-input"
              value={icsContent}
              onChange={(event) => setIcsContent(event.target.value)}
              placeholder="BEGIN:VCALENDAR..."
              rows={8}
            />
          </Field>
          {importNote ? (
            <div className="dv-notice" role="status"><span>{importNote.title}. {importNote.description}</span></div>
          ) : importIcs.error ? (
            <div className="dv-notice dv-notice--bad" role="alert"><AlertCircle aria-hidden="true" /><span>Import failed: {formatError(importIcs.error)}</span></div>
          ) : null}
        </form>
      </Dialog>
    </ErrorBoundary>
  );
}
