/**
 * The mode chip at the right of the shell header (ux A7.4): which permission
 * mode is in force, in the daemon's words (lib/mode-in-force.ts). It reads
 * `Jev decides · asking you for now` while the chosen mode cannot be used, or
 * just the mode's label (`Ask me`, `Just vibes`, `YOLO`) when nothing differs.
 * On a phone it shortens to `Asking you for now` or the label. Tapping it opens
 * the reading's sentence and `Change`, which opens Settings > Permissions; on a
 * phone that is a bottom sheet (the kit Menu).
 *
 * Amber only while the mode in force differs (it needs you); the words always
 * say so too.
 */
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { useDaemonModeInForce } from '../../lib/mode-in-force';
import { Menu, MenuItem, MenuMeta } from '../ui/Menu';
import '../../styles/components/status.css';

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function ModeChip({ onOpenSettings }: { onOpenSettings: (section: string) => void }) {
  const reading = useDaemonModeInForce();
  const words = reading.data?.words;
  if (!words) return null;
  const differs = words.inForce !== undefined;
  const full = differs ? `${words.chosen} · ${words.inForce}` : words.chosen;
  const short = differs ? capitalized(words.inForce ?? '') : words.chosen;
  const accessible = differs && words.because ? `${full}: ${words.because}` : full;
  return (
    <Menu
      label="Permission mode"
      placement="bottom-end"
      width={300}
      trigger={(props) => (
        <button
          type="button"
          {...props}
          aria-label={`Permission mode: ${accessible}`}
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
      <MenuMeta>
        <span className="mode-chip__sentence">{words.sentence}</span>
      </MenuMeta>
      <MenuItem onSelect={() => onOpenSettings('permissions')}>Change</MenuItem>
    </Menu>
  );
}
