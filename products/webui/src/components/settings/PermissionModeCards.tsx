/**
 * The four permission modes as radio cards, first on Settings > Permissions
 * (ux A7.5): Ask me, Jev decides, Just vibes, YOLO, each with its one plain
 * description (GATE_PRESETS[...].summary). Under the chosen card, when the mode
 * in force differs, the daemon's words for it as the terminal's status bar
 * shows them (`Permissions: asking you, for now · Jev decides once a decision model is set`,
 * lib/mode-in-force.ts). Picking a card sets the
 * daemon-wide mode with sessions.permissionMode.set (a looser mode set from a
 * token minted for automation waits for the owner; OwnerApprovalNotices says so).
 *
 * Plan is a posture a session enters, not a saved choice, so it has no card;
 * while it is in force no card is checked.
 */
import { useId } from 'react';
import { GATE_PRESETS, type SettableGatePresetName } from '@goodvibes/engine/platform/platform/gate/presets';
import { formatError } from '../../lib/errors';
import { OwnerApprovalPendingError } from '../../lib/owner-approval';
import { modeInForceLine, useDaemonModeInForce, useSetDaemonMode } from '../../lib/mode-in-force';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import '../../styles/components/permission-modes.css';

const CARD_MODES = ['ask-me', 'jev-decides', 'just-vibes', 'yolo'] as const satisfies readonly SettableGatePresetName[];

export function PermissionModeCards() {
  const name = useId();
  const reading = useDaemonModeInForce();
  const setMode = useSetDaemonMode();
  const chosen = reading.data?.chosenMode ?? '';
  const words = reading.data?.words;
  // The terminal's status-bar words: what is in force first, the choice second, a failure last.
  const inForceLine = words?.inForce ? `Permissions: ${modeInForceLine(words)}` : null;

  if (reading.isPending) return <SkeletonBlock variant="text" lines={4} />;

  return (
    <div className="permission-modes">
      <div className="permission-modes__grid" role="radiogroup" aria-label="When GoodVibes asks">
        {CARD_MODES.map((mode) => {
          const preset = GATE_PRESETS[mode];
          const checked = mode === chosen;
          const pending = setMode.isPending && setMode.variables === mode;
          return (
            <label key={mode} className={`permission-mode-card${checked ? ' permission-mode-card--checked' : ''}`}>
              <input
                type="radio"
                name={name}
                className="permission-mode-card__input"
                checked={checked}
                disabled={setMode.isPending}
                onChange={() => setMode.mutate(mode)}
              />
              <span className="permission-mode-card__title">
                <span className="permission-mode-card__dot" aria-hidden="true" />
                {preset.label}{pending ? '…' : ''}
              </span>
              <span className="permission-mode-card__summary">{preset.summary}</span>
              {checked && inForceLine && (
                <span className="permission-mode-card__in-force" role="status">{inForceLine}</span>
              )}
            </label>
          );
        })}
      </div>
      {reading.isError && (
        <p className="settings-empty" role="alert">Couldn&rsquo;t read the mode in force: {formatError(reading.error)}</p>
      )}
      {setMode.isError && !(setMode.error instanceof OwnerApprovalPendingError) && (
        <p className="settings-empty" role="alert">The mode was not changed: {formatError(setMode.error)}</p>
      )}
    </div>
  );
}
