/**
 * The mode chip at the right of the shell header (ux A7.4): when GoodVibes
 * asks, in the same words as the terminal's status bar
 * (lib/mode-in-force.ts). It leads with what is in force: `Asks: Jev decides`
 * when the chosen mode is in force, `Asks: you, for now · Jev decides with a
 * decision model` while it cannot be used (a failure such as `decision model
 * unreachable` last). On a phone, where even `Asks: you, for now · default:
 * Jev decides` cut the mode in force short (seen at 390 wide), it shows the
 * mode in force alone and the sheet opens with the whole line.
 * Tapping it opens the reading's sentence and
 * `Change`, which opens Settings > Permissions; on a phone that is a bottom
 * sheet (the kit Menu).
 *
 * Amber only while the mode in force differs (it needs you); the words always
 * say so too.
 */
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { modeInForceLine, useDaemonModeInForce } from '../../lib/mode-in-force';
import { Menu, MenuItem, MenuMeta } from '../ui/Menu';
import '../../styles/components/status.css';

export function ModeChip({ onOpenSettings }: { onOpenSettings: (section: string) => void }) {
  const reading = useDaemonModeInForce();
  const words = reading.data?.words;
  if (!words) return null;
  const differs = words.inForce !== undefined;
  const full = `Asks: ${modeInForceLine(words)}`;
  // A phone header has room for the mode in force only; the choice is in the sheet it opens.
  const short = `Asks: ${words.inForce ?? words.chosen}`;
  // A reason that is not drawn on the chip (it states a choice) is still read out.
  const accessible = differs && words.because && words.failure !== true ? `${full}: ${words.because}` : full;
  return (
    <Menu
      label="When GoodVibes asks"
      placement="bottom-end"
      width={300}
      trigger={(props) => (
        <button
          type="button"
          {...props}
          aria-label={`When GoodVibes asks. ${accessible}`}
          className={`status-strip__segment status-strip__segment--button mode-chip${differs ? ' mode-chip--differs' : ''}`}
        >
          {differs
            ? <ShieldAlert className="status-strip__icon" aria-hidden="true" size={12} />
            : <ShieldCheck className="status-strip__icon" aria-hidden="true" size={12} />}
          <span className="status-strip__label mode-chip__full">{full}</span>
          <span className="status-strip__label mode-chip__short">{short}</span>
        </button>
      )}
    >
      <ModeSheetItems onOpenSettings={onOpenSettings} withLabel={differs} />
    </Menu>
  );
}

/**
 * What the chip opens: the reading's sentence and `Change`. A chat's `asking
 * you` chip shows the same items on a phone header, where the mode chip steps
 * aside so the chat's title fits (ux A2.4, A7.4); with `withLabel` they open
 * with the chip's own words, since the chip is not on screen then.
 */
export function ModeSheetItems({ onOpenSettings, withLabel = false }: { onOpenSettings?: ((section: string) => void) | undefined; withLabel?: boolean }) {
  const words = useDaemonModeInForce().data?.words;
  if (!words) return null;
  return (
    <>
      <MenuMeta>
        {withLabel && <span className="mode-chip__sheet-label">Asks: {modeInForceLine(words)}</span>}
        <span className="mode-chip__sentence">{words.sentence}</span>
      </MenuMeta>
      {onOpenSettings && <MenuItem onSelect={() => onOpenSettings('permissions')}>Change</MenuItem>}
    </>
  );
}
