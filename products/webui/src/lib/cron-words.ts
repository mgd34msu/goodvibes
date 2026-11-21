/**
 * A five-field cron schedule in words, for the common shapes a person sets:
 * every day, on weekdays, on certain days of the week, every hour, every few
 * minutes. Anything else reads as the expression itself, so nothing is guessed.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function wholeNumber(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

function daysOfWeek(field: string): string | null {
  if (field === '*') return 'Every day';
  if (field === '1-5') return 'On weekdays';
  if (field === '0,6' || field === '6,0') return 'On weekends';
  const days = field.split(',').map((part) => wholeNumber(part, 0, 7));
  if (days.some((day) => day === null)) return null;
  const names = [...new Set(days.map((day) => DAY_NAMES[(day as number) % 7]))];
  if (names.length === 1) return `Every ${names[0]}`;
  return `On ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The schedule in words, or null when its shape is not one read here. */
export function cronInWords(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  if (dayOfMonth !== '*' || month !== '*') return null;
  const minute = wholeNumber(minuteField, 0, 59);
  const hour = wholeNumber(hourField, 0, 23);
  if (minute !== null && hour !== null) {
    const days = daysOfWeek(dayOfWeek);
    return days ? `${days} at ${clock(hour, minute)}` : null;
  }
  if (dayOfWeek !== '*') return null;
  if (minute !== null && hourField === '*') return minute === 0 ? 'Every hour, on the hour' : `Every hour at ${String(minute).padStart(2, '0')} past`;
  const step = /^\*\/(\d+)$/.exec(minuteField);
  if (step && hourField === '*') {
    const every = Number(step[1]);
    if (every === 1) return 'Every minute';
    // The step restarts at :00 every hour, so only a step that divides 60 is an even cadence.
    return every >= 2 && every <= 30 && 60 % every === 0 ? `Every ${every} minutes` : null;
  }
  return null;
}
