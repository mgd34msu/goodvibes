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
    label: 'Time zone for daily budgets and reminders',
    type: 'string',
    description:
      "IANA timezone name the daemon reckons CALENDAR DAYS in, e.g. 'America/New_York', 'Europe/London'. Empty means UTC. This is the daemon's own location, not a display preference and not a per-schedule zone (schedules keep their own). Anything that resets daily reads it: the payment capability's daily budgets roll over at midnight in this zone. Changing it does not refill a spent budget: each spend keeps the day it was made on and counts until that day is over, and an agent cannot change it in a way that moves today; only the owner can.",
    validate: (value: unknown): boolean => typeof value === 'string' && (value.trim().length === 0 || isValidTimezone(value)),
    validationHint: "empty (UTC) or an IANA timezone name like 'America/New_York'",
  },
];
