/**
 * EventAbout, what a runtime event is about, declared by the code that emits it: the project the record belongs to
 * (null: it belongs to no project, the owner's own), the record's kind and its id. The daemon's stream filter
 * (control-plane/event-reach.ts) reads it to deliver the event to the callers that may reach that project, and the
 * record's own parts the event names by id (a contract's units, groups and checks; a watcher's checkpoint; a work plan
 * task's links) are read as parts of it, not as other records.
 */

/** The kinds of record an event declares itself about. */
export const EVENT_ABOUT_KINDS = ['contract', 'watcher', 'work-plan', 'work-plan-task', 'checkpoint'] as const;

export type EventAboutKind = (typeof EVENT_ABOUT_KINDS)[number];

export interface EventAbout {
  /** The project folder the record belongs to; null when it belongs to no project (the owner's alone). */
  readonly project: string | null;
  readonly kind: EventAboutKind;
  /** The record's id (a contract's, a watcher's, a work plan task's). */
  readonly id: string;
}
