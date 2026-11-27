/**
 * Repeat purchases: what a schedule or trigger may buy again without asking
 * each time, within the limits the owner set. Each row is one allowance in
 * the daemon's own words (its shop, item, limits, what is left and its last
 * day) with "Stop"; "Allow a repeat purchase…" opens the `/payments` sheet
 * with the same six blanks and the same sentence as the terminal. Both are
 * the owner's own acts, sent with their explicit request.
 */
import { asArray, asRecord } from '../../../lib/object';
import { Row, RowList } from '../../ui/Row';
import { StatusDot } from '../../ui/StatusDot';
import { ActionButtons } from '../ActionButtons';
import { CommandScreen, ReadState, useCommandRead, useRefreshCommandScreens } from './CommandScreen';

interface RepeatRow {
  readonly id: string;
  readonly item: string;
  readonly shops: string;
  readonly summary: string;
  readonly live: boolean;
}

function readRows(output: unknown): readonly RepeatRow[] {
  return asArray(asRecord(output).authorizations).map((value) => {
    const entry = asRecord(value);
    return {
      id: String(entry.id ?? ''),
      item: String(entry.item ?? ''),
      shops: asArray(entry.merchants).map(String).join(', '),
      summary: String(entry.summary ?? ''),
      live: entry.live !== false,
    };
  }).filter((row) => row.id);
}

export function RepeatPurchases() {
  const read = useCommandRead('repeat-purchases', 'payments.standing.list');
  const refresh = useRefreshCommandScreens();
  const rows = read.data ? readRows(read.data) : [];
  return (
    <CommandScreen
      command="payments"
      title="Repeat purchases"
      summary="What a schedule may buy again without asking you each time. Every other spending limit still applies."
      testId="repeat-purchases"
      actions={<ActionButtons command="payments" actions={['allow-repeat']} primary onDone={refresh} />}
    >
      <ReadState read={read} isEmpty={rows.length === 0} empty="No repeat purchases allowed. A schedule asks you before every purchase." />
      {rows.length > 0 ? (
        <RowList aria-label="Repeat purchases">
          {rows.map((row) => (
            <Row
              key={row.id}
              leading={<StatusDot tone={row.live ? 'ok' : 'idle'} srLabel={row.live ? 'Allowed' : 'Ended'} />}
              title={`${row.item} · ${row.shops}`}
              meta={row.summary}
              trailing={<ActionButtons command="payments" short actions={['stop-repeat']} prefill={{ repeat: row.id }} onDone={refresh} />}
            />
          ))}
        </RowList>
      ) : null}
    </CommandScreen>
  );
}
