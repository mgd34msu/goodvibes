import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { IDEMPOTENCY_KEY_REPLAY } from './idempotent-replay.js';
import {
  BOOLEAN_SCHEMA,
  STRING_SCHEMA,
  NUMBER_SCHEMA,
  arraySchema,
  objectSchema,
  listOutputSchema,
  bodyEnvelopeSchema,
  methodDescriptor,
} from './method-catalog-shared.js';

const CALENDAR_EVENT_SUMMARY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  start: STRING_SCHEMA,
  end: STRING_SCHEMA,
  allDay: BOOLEAN_SCHEMA,
  location: STRING_SCHEMA,
  description: STRING_SCHEMA,
  attendees: arraySchema(STRING_SCHEMA),
}, ['id', 'title', 'start', 'end']);

const CALENDAR_EVENT_DETAIL_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  uid: STRING_SCHEMA,
  title: STRING_SCHEMA,
  start: STRING_SCHEMA,
  end: STRING_SCHEMA,
  allDay: BOOLEAN_SCHEMA,
  location: STRING_SCHEMA,
  description: STRING_SCHEMA,
  attendees: arraySchema(STRING_SCHEMA),
  recurrence: STRING_SCHEMA,
  revision: STRING_SCHEMA,
}, ['id', 'title', 'start', 'end']);

/**
 * Calendar operator methods, event read/write and iCalendar import/export
 * through the standard operator method protocol.
 *
 * These are SERVED. `registerCalendarGatewayMethods`
 * (control-plane/routes/calendar.ts) attaches an in-process handler to each id
 * over a `CalendarGatewayService`, the daemon composition supplies the
 * configured backend (a CalDAV server, or a connected Google account;
 * control-plane/routes/calendar-composition.ts), and
 * the gateway REST arm serves each advertised http path with the same handler, so
 * the REST path and the methodId-invoke endpoint resolve identically.
 *
 * They did not used to be. For a long time none of these five http paths was
 * served by anything: there was no /api/calendar surface at any prefix, no
 * calendar-routes.ts, and no handler. They carried `invokable: false` so the
 * published contract and the live method-dispatch path both said "cataloged,
 * not callable" rather than letting a caller discover the 404 the hard way.
 * The reason was never the routing, it was that the only implementation
 * lived inside one product, so the daemon had nothing to call, and scheduled
 * work, triggers and channel-driven work could not touch a calendar at all.
 * Hoisting the connector into the platform is what made serving them possible.
 *
 * The route-reconcile regression gate (method-catalog-route-reconcile.ts,
 * exercised in test/capability-route-reconcile.test.ts) keeps the two halves
 * honest in both directions: a descriptor that advertises an http path no
 * route serves reddens it, and so does one that quietly reappears unmarked.
 */
export const builtinGatewayCalendarMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'calendar.events.list',
    title: 'List Calendar Events',
    description: 'Return event summaries from the configured calendar (a CalDAV server, or the connected Google account) within an optional time window. With no from or to, lists from 24 hours ago to 30 days ahead; a recurring event is listed at each occurrence in the window, each with its own id (on CalDAV, the resource href plus `#` and the occurrence\'s RECURRENCE-ID instant).',
    category: 'calendar',
    effects: ['calendar.read'],
    http: { method: 'GET', path: '/api/calendar/events' },
    inputSchema: objectSchema({
      calendarId: STRING_SCHEMA,
      from: STRING_SCHEMA,
      to: STRING_SCHEMA,
      limit: NUMBER_SCHEMA,
    }),
    outputSchema: objectSchema({
      events: arraySchema(CALENDAR_EVENT_SUMMARY_SCHEMA),
      more: BOOLEAN_SCHEMA,
    }, ['events', 'more'], { additionalProperties: false }),
  }),
  methodDescriptor({
    id: 'calendar.events.get',
    title: 'Get Calendar Event',
    description: 'Return the full event object including attendees, recurrence, raw iCalendar UID and revision (the calendar\'s version of it, to send back as expectedRevision on calendar.events.update). An occurrence id from calendar.events.list returns that occurrence (its own start, end and any change made to it), not the first of its series.',
    category: 'calendar',
    effects: ['calendar.read'],
    http: { method: 'GET', path: '/api/calendar/events/{eventId}' },
    inputSchema: objectSchema({
      eventId: STRING_SCHEMA,
      calendarId: STRING_SCHEMA,
    }, ['eventId']),
    outputSchema: CALENDAR_EVENT_DETAIL_SCHEMA,
  }),
  methodDescriptor({
    id: 'calendar.events.create',
    replay: IDEMPOTENCY_KEY_REPLAY,
    confirmation: 'confirm',
    recipients: ['attendees[]'],
    title: 'Create Calendar Event',
    description: 'Create an event on the configured calendar. Requires explicit confirmation (confirm: true); attendees are invited by the calendar. When the calendar server takes the request but sends no answer, the call fails with 502 CALENDAR_OUTCOME_UNKNOWN naming the new event\'s UID (on Google Calendar, its event id): read it with calendar.events.get before creating it again. Change it with calendar.events.update and remove it with calendar.events.delete.',
    category: 'calendar',
    effects: ['calendar.administer', 'outward.send'],
    dangerous: true,
    http: { method: 'POST', path: '/api/calendar/events' },
    inputSchema: bodyEnvelopeSchema({
      title: STRING_SCHEMA,
      start: STRING_SCHEMA,
      end: STRING_SCHEMA,
      description: STRING_SCHEMA,
      attendees: arraySchema(STRING_SCHEMA),
      location: STRING_SCHEMA,
      calendarId: STRING_SCHEMA,
      confirm: BOOLEAN_SCHEMA,
    }, ['title', 'start', 'end']),
    outputSchema: objectSchema({
      eventId: STRING_SCHEMA,
      uid: STRING_SCHEMA,
      createdAt: STRING_SCHEMA,
    }, ['eventId', 'uid', 'createdAt']),
  }),
  methodDescriptor({
    id: 'calendar.events.update',
    replay: IDEMPOTENCY_KEY_REPLAY,
    confirmation: 'confirm',
    recipients: ['attendees[]'],
    title: 'Update Calendar Event',
    description: 'Change an event on the configured calendar (Google or CalDAV): only the fields sent change (attendees replaces the guest list; start and end are both dates for an all-day event or both date-times). Requires explicit confirmation (confirm: true). An unknown eventId is a 404; an id that names a whole recurring series is refused with 409 CALENDAR_SERIES_NOT_SUPPORTED (on Google, one occurrence is changed by the id calendar.events.list gives it); an event that changed on the calendar after it was read is refused with 409 CALENDAR_EVENT_CHANGED and nothing is written. Send expectedRevision (the revision calendar.events.get returned when the event was shown) so a change made elsewhere after it was shown is refused the same way; read the event again and repeat the change. A backend that cannot change events answers 501 CALENDAR_NOT_SUPPORTED.',
    category: 'calendar',
    effects: ['calendar.administer', 'outward.send'],
    dangerous: true,
    http: { method: 'PATCH', path: '/api/calendar/events/{eventId}' },
    inputSchema: bodyEnvelopeSchema({
      eventId: STRING_SCHEMA,
      title: STRING_SCHEMA,
      start: STRING_SCHEMA,
      end: STRING_SCHEMA,
      description: STRING_SCHEMA,
      attendees: arraySchema(STRING_SCHEMA),
      location: STRING_SCHEMA,
      calendarId: STRING_SCHEMA,
      expectedRevision: STRING_SCHEMA,
      confirm: BOOLEAN_SCHEMA,
    }, ['eventId']),
    outputSchema: objectSchema({
      eventId: STRING_SCHEMA,
      updatedAt: STRING_SCHEMA,
    }, ['eventId', 'updatedAt']),
  }),
  methodDescriptor({
    id: 'calendar.events.delete',
    repeat: 'safe',
    confirmation: 'confirm',
    effects: ['calendar.administer', 'record.destroy', 'outward.send'],
    title: 'Delete Calendar Event',
    description: 'Remove an event from the configured calendar (Google or CalDAV). Requires explicit confirmation (confirm: true). `deleted: false` means the calendar no longer held it. A whole recurring series is refused with 409 CALENDAR_SERIES_NOT_SUPPORTED (on Google, one occurrence is removed by the id calendar.events.list gives it); an event that changed after it was read is refused with 409 CALENDAR_EVENT_CHANGED. A backend that cannot delete events answers 501 CALENDAR_NOT_SUPPORTED.',
    category: 'calendar',
    dangerous: true,
    http: { method: 'DELETE', path: '/api/calendar/events/{eventId}' },
    inputSchema: bodyEnvelopeSchema({
      eventId: STRING_SCHEMA,
      calendarId: STRING_SCHEMA,
      confirm: BOOLEAN_SCHEMA,
    }, ['eventId']),
    outputSchema: objectSchema({
      eventId: STRING_SCHEMA,
      deleted: BOOLEAN_SCHEMA,
    }, ['eventId', 'deleted']),
  }),
  methodDescriptor({
    id: 'calendar.calendars.list',
    title: 'List Calendars',
    description: 'The calendars the configured account can reach (the Google calendar list, or the CalDAV collections), so a client can offer them as choices and setup can offer them for surfaces.calendar.defaultCalendarId. A backend that cannot discover calendars answers 501 CALENDAR_NOT_SUPPORTED.',
    category: 'calendar',
    effects: ['calendar.read'],
    http: { method: 'GET', path: '/api/calendar/calendars' },
    inputSchema: objectSchema({}),
    outputSchema: listOutputSchema('calendars', objectSchema({
      calendarId: STRING_SCHEMA,
      displayName: STRING_SCHEMA,
    }, ['calendarId', 'displayName'])),
  }),
  methodDescriptor({
    id: 'calendar.ics.import',
    replay: IDEMPOTENCY_KEY_REPLAY,
    confirmation: 'confirm',
    title: 'Import iCalendar',
    description: 'Import raw .ics content into the configured calendar. Requires explicit confirmation (confirm: true). A series and its overrides are stored together as written; an event already on the calendar is kept unless replace: true. Guests an imported event names are not invited; they are listed in attendeesLeftOff.',
    category: 'calendar',
    effects: ['calendar.administer', 'outward.send'],
    dangerous: true,
    http: { method: 'POST', path: '/api/calendar/ics/import' },
    inputSchema: bodyEnvelopeSchema({
      icsContent: STRING_SCHEMA,
      calendarId: STRING_SCHEMA,
      replace: BOOLEAN_SCHEMA,
      confirm: BOOLEAN_SCHEMA,
    }, ['icsContent']),
    outputSchema: objectSchema({
      imported: NUMBER_SCHEMA,
      eventIds: arraySchema(STRING_SCHEMA),
      errors: arraySchema(STRING_SCHEMA),
      attendeesLeftOff: arraySchema(objectSchema({
        eventId: STRING_SCHEMA,
        title: STRING_SCHEMA,
        attendees: arraySchema(STRING_SCHEMA),
        next: STRING_SCHEMA,
      }, ['eventId', 'title', 'attendees', 'next'])),
    }, ['imported', 'eventIds', 'errors']),
  }),
  methodDescriptor({
    id: 'calendar.ics.export',
    title: 'Export iCalendar',
    description: 'Export events from the configured calendar as raw .ics content within an optional time window. With no limit every event in the window is exported; with a limit the export stops there and more: true says the window holds further events.',
    category: 'calendar',
    effects: ['calendar.read'],
    http: { method: 'GET', path: '/api/calendar/ics/export' },
    inputSchema: objectSchema({
      calendarId: STRING_SCHEMA,
      from: STRING_SCHEMA,
      to: STRING_SCHEMA,
      limit: NUMBER_SCHEMA,
    }),
    outputSchema: objectSchema({
      icsContent: STRING_SCHEMA,
      eventCount: NUMBER_SCHEMA,
      more: BOOLEAN_SCHEMA,
    }, ['icsContent', 'eventCount']),
  }),
];
