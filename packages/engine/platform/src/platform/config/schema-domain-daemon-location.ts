/**
 * schema-domain-daemon-location.ts, where on earth the daemon thinks it is.
 *
 * Split from schema-domain-core.ts to keep that file under its line ceiling,
 * and separate on merit: this is the platform's ONLY notion of the daemon's
 * location, and it is general rather than owned by whichever feature needed it
 * first. Anything that resets on a calendar day reads it.
 *
 * Before this existed the daemon had no timezone concept at all, schedules
 * carried their own per-schedule IANA names and `device.location.*` is a paired
 * phone's GPS permission, neither of which says where the daemon is. A daily
 * budget cannot be built without that answer.
 */
import type { ConfigSettingRow } from './schema-types.js';
import { isValidTimezone } from '../utils/timezone.js';

export const daemonLocationConfigSettings: ConfigSettingRow[] = [
  {
    key: 'daemon.timezone',
    label: 'Time zone for daily budgets, reminders and new schedules',
    type: 'string',
    description:
      "IANA timezone name for where the owner is, e.g. 'America/New_York', 'Europe/London'. Anything that resets daily reads it: the payment capability's daily budgets roll over at midnight in this zone (UTC when empty). It is also the default zone for a schedule or reminder created without one: a repeating time such as weekdays at 08:00 is kept in this zone (the host's own zone when empty). A schedule created with a zone, or from a terminal or browser that sends where the time was typed, keeps that zone, and changing this setting does not move schedules already kept. Changing it does not refill a spent budget: each spend keeps the day it was made on and counts until that day is over, and an agent cannot change it in a way that moves today; only the owner can.",
    validate: (value: unknown): boolean => typeof value === 'string' && (value.trim().length === 0 || isValidTimezone(value)),
    validationHint: "empty (UTC) or an IANA timezone name like 'America/New_York'",
  },
];
