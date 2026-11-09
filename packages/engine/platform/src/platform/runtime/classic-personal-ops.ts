/** Explicit conventional provider fields only; these are native display projections, not semantic findings. */
const DISPLAY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'calendar event identifier': ['eventId', 'id', 'uid'],
  'email message or thread identifier': ['messageId', 'threadId', 'id'],
  'calendar event title': ['title', 'summary'],
  'email message subject': ['subject', 'title'],
  'calendar event organizer, calendar or location': ['organizer', 'calendar', 'location'],
  'email message sender': ['from', 'sender'],
  'calendar event start time': ['start', 'startAt', 'startTime'],
  'message received time': ['receivedAt', 'date', 'timestamp'],
  'calendar event description': ['description', 'notes'],
  'message body or preview text': ['body', 'text', 'snippet', 'preview'],
};

export function classicPersonalOpsResultField(record: Readonly<Record<string, unknown>>, purpose: string): string | null {
  if (purpose === 'primary returned personal record collection or its enclosing result object') {
    return ['items', 'records', 'events', 'messages', 'threads', 'results', 'data', 'result'].find(key => {
      if (!Object.hasOwn(record, key)) return false;
      const value = record[key];
      return value !== null && typeof value === 'object';
    }) ?? null;
  }
  const prefix = 'review record field serving one of: ';
  const keys = purpose.startsWith(prefix) ? purpose.slice(prefix.length).split(', ')
    : Object.hasOwn(DISPLAY_FIELDS, purpose) ? DISPLAY_FIELDS[purpose] ?? [] : [];
  return keys.find(key => Object.hasOwn(record, key) && ['string', 'number', 'boolean'].includes(typeof record[key])) ?? null;
}

/** Preserve an exact outcome declaration. Prose, missing facts and contradictions remain unassessed. */
export function classicPersonalOpsReceiptStatus(source: unknown): 'succeeded' | 'blocked' | 'failed' | 'running' | 'other' | 'unassessed' {
  const statuses = ['succeeded', 'blocked', 'failed', 'running', 'other'] as const;
  const records = source && typeof source === 'object' && !Array.isArray(source) ? [source as Readonly<Record<string, unknown>>] : [];
  const metadata = records[0]?.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) records.push(metadata as Readonly<Record<string, unknown>>);
  const values: unknown[] = records.flatMap(record => ['status', 'state', 'outcome'].filter(key => Object.hasOwn(record, key) && record[key] !== undefined).map(key => record[key]));
  if (!values.length || new Set(values).size !== 1) return 'unassessed';
  return statuses.find(status => status === values[0]) ?? 'unassessed';
}
