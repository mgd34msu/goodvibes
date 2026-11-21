/**
 * Schedules: what runs at set times, with or without an app open. Each row
 * shows the schedule's name, when it runs and its next run, and carries the
 * `/schedule` actions that apply to it (run now, pause or resume, change,
 * remove) as sheets drawn from the command's description. "Change" is the
 * schedule editor: its blanks show what the schedule holds now, and a new
 * time in words is read by the daemon and shown before it is kept.
 */
import { cronInWords } from '../../../lib/cron-words';
import { asArray, asRecord } from '../../../lib/object';
import { whenLabel } from '../../../lib/when-label';
import { Row, RowList } from '../../ui/Row';
import { StatusDot } from '../../ui/StatusDot';
import { ActionButtons } from '../ActionButtons';
import { CommandScreen, ReadState, useCommandRead, useRefreshCommandScreens } from './CommandScreen';

const UNITS: readonly [number, string][] = [[86_400_000, 'day'], [3_600_000, 'hour'], [60_000, 'minute'], [1_000, 'second']];

function everyWords(ms: number): string {
  for (const [size, unit] of UNITS) {
    if (ms >= size && ms % size === 0) {
      const count = ms / size;
      return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
    }
  }
  return `Every ${ms} ms`;
}

/** When a kept schedule runs, in words. */
export function scheduleTimingWords(schedule: unknown): string {
  const record = asRecord(schedule);
  if (record.kind === 'every' && typeof record.intervalMs === 'number') return everyWords(record.intervalMs);
  if (record.kind === 'at' && typeof record.at === 'number') return `Once, ${new Date(record.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`;
  if (record.kind === 'cron' && typeof record.expression === 'string') {
    const zone = typeof record.timezone === 'string' ? ` (${record.timezone})` : '';
    return `${cronInWords(record.expression) ?? record.expression}${zone}`;
  }
  return 'No timing';
}

interface ScheduleRow {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly timing: string;
  readonly next: string;
  readonly prompt: string;
  readonly outcome: string;
}

function readRows(output: unknown): readonly ScheduleRow[] {
  return asArray(asRecord(output).jobs).map((value) => {
    const job = asRecord(value);
    const execution = asRecord(job.execution);
    const prompt = typeof execution.prompt === 'string' ? execution.prompt : typeof job.description === 'string' ? job.description : '';
    const enabled = job.enabled !== false;
    return {
      id: String(job.id ?? ''),
      name: String(job.name ?? job.id ?? ''),
      enabled,
      timing: scheduleTimingWords(job.schedule),
      next: enabled ? whenLabel(typeof job.nextRunAt === 'number' ? job.nextRunAt : null) : '',
      prompt,
      outcome: job.lastOutcome === 'failed' ? 'last run failed'
        : job.lastOutcome === 'not-delivered' ? 'last run not delivered'
          : job.lastOutcome === 'partly-delivered' ? 'last run delivered to some, not all'
            : '',
    };
  }).filter((row) => row.id);
}

export function SchedulesPanel() {
  const read = useCommandRead('schedules', 'automation.schedules.list');
  const refresh = useRefreshCommandScreens();
  const rows = read.data ? readRows(read.data) : [];
  return (
    <CommandScreen
      command="schedule"
      testId="schedules-panel"
      actions={<ActionButtons command="schedule" actions={['add']} primary onDone={refresh} />}
    >
      <ReadState read={read} isEmpty={rows.length === 0} empty="No schedules yet. Schedule something to run, and it runs whether or not an app is open." />
      {rows.length > 0 ? (
        <RowList aria-label="Schedules">
          {rows.map((row) => (
            <Row
              key={row.id}
              leading={<StatusDot tone={row.outcome ? 'warn' : row.enabled ? 'ok' : 'idle'} srLabel={row.enabled ? 'Runs' : 'Paused'} />}
              title={`${row.name}${row.enabled ? '' : ' (paused)'}`}
              meta={[row.timing, row.next ? `next ${row.next}` : '', row.outcome].filter(Boolean).join(' · ')}
              trailing={(
                <ActionButtons
                  command="schedule"
                  short
                  actions={['run-now', row.enabled ? 'pause' : 'resume', 'change']}
                  menu={['remove']}
                  menuLabel={`More for ${row.name}`}
                  prefill={{ schedule: row.id }}
                  current={{ name: row.name, prompt: row.prompt }}
                  onDone={refresh}
                />
              )}
            />
          ))}
        </RowList>
      ) : null}
    </CommandScreen>
  );
}
