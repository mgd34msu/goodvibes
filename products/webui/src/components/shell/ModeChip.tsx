/**
 * The mode chip at the right of the shell header (ux A7.4): when GoodVibes
 * asks, in the same words as the terminal's status bar
 * (lib/mode-in-force.ts). It leads with what is in force: `Permissions: Jev
 * decides` when the chosen mode is in force, `Permissions: asking you, for now
 * · Jev decides once a decision model is set` while it cannot be used (a
 * failure such as `decision model unreachable` last). On the chip itself that
 * line is cut to the mode in force and its cause (`Permissions: asking you, for
 * now · no decision model set`); on a phone, to the shield and one word for the
 * mode in force (`Asking`), so the chat's title keeps its room. The sheet it opens starts with the whole line, then the
 * reading's sentence, the one step that fixes the cause (`Choose a decision
 * model`, `Turn decision models on`, `Check the decision model`: Settings >
 * Models and providers > Decision models) and `Change`, which opens Settings > Permissions; on a
 * phone that is a bottom sheet (the kit Menu).
 *
 * Amber only while the mode in force differs (it needs you); the words always
 * say so too.
 */
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { modeInForceLine, useDaemonModeInForce, type ModeInForceWords } from '../../lib/mode-in-force';
import { Menu, MenuItem, MenuMeta } from '../ui/Menu';
import '../../styles/components/status.css';

export function ModeChip({ onOpenSettings }: { onOpenSettings: (section: string) => void }) {
  const reading = useDaemonModeInForce();
  const words = reading.data?.words;
  if (!words) return null;
  const differs = words.inForce !== undefined;
  const full = `Permissions: ${modeInForceLine(words)}`;
  // The desktop chip: the mode in force and its cause in two or three words ("no decision model set",
  // "decision model unreachable"); the choice and when it takes effect are the sheet's first line.
  const chip = differs ? `Permissions: ${[words.inForce, words.because ?? words.chosenShort].filter(Boolean).join(' · ')}` : full;
  // A phone header gives the chip its shield and one word for the mode in force, so the chat's
  // title keeps its room; the whole line is the sheet's first line and the button's name.
  const short = oneWord(words.inForce ?? words.chosen);
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
          <span className="status-strip__label mode-chip__full">{chip}</span>
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
  const cause = causeAction(words);
  return (
    <>
      <MenuMeta>
        {withLabel && <span className="mode-chip__sheet-label">Permissions: {modeInForceLine(words)}</span>}
        <span className="mode-chip__sentence">{words.sentence}</span>
      </MenuMeta>
      {onOpenSettings && cause && <MenuItem onSelect={() => onOpenSettings(cause.section)}>{cause.label}</MenuItem>}
      {onOpenSettings && <MenuItem onSelect={() => onOpenSettings('permissions')}>Change</MenuItem>}
    </>
  );
}

/**
 * The mode in force in one word, for the phone chip: "asking you, for now" and "Ask me"
 * read "Asking", "Jev decides" "Jev", "Just vibes" "Vibes", "YOLO, for now" "YOLO";
 * any other label its first word.
 */
function oneWord(mode: string): string {
  const lower = mode.trim().toLowerCase();
  if (lower.startsWith('ask')) return 'Asking';
  if (lower.startsWith('just vibes')) return 'Vibes';
  const first = mode.trim().split(/[\s,·]+/)[0] ?? mode;
  return first ? `${first.charAt(0).toUpperCase()}${first.slice(1)}` : mode;
}

/**
 * The one step that puts the chosen mode in force, beside Change: the decision
 * model is chosen, switched on and repaired in Settings > Models and providers >
 * Decision models, so a mode held back by it opens there. Read from
 * the reading's own `because` words (decision-model-readiness.ts becauseWords).
 */
function causeAction(words: ModeInForceWords): { label: string; section: string } | undefined {
  if (words.inForce === undefined || !words.because) return undefined;
  switch (words.because) {
    case 'no decision model set': return { label: 'Choose a decision model', section: 'decision-models' };
    case 'decision model unreachable':
    case 'decision model failing': return { label: 'Check the decision model', section: 'decision-models' };
    default: return undefined;
  }
}
