/** `  delivery <mode> (<n> targets)` for a schedule record as the host returned it. */
export function scheduleDeliveryLine(schedule: Record<string, unknown>): string {
  const delivery = schedule.delivery;
  const policy: Record<string, unknown> = delivery && typeof delivery === 'object' && !Array.isArray(delivery)
    ? delivery as Record<string, unknown>
    : {};
  const mode = typeof policy.mode === 'string' ? policy.mode : 'none';
  const count = Array.isArray(policy.targets) ? policy.targets.length : 0;
  return `  delivery ${mode}${count > 0 ? ` (${count} target${count === 1 ? '' : 's'})` : ''}`;
}
