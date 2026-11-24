/**
 * The account button and its menu (design doc "Glass and elevation" specimen and
 * the deep dive's "Account menu"). Replaces the bottom status strip: who you
 * are, "Finish setting up" while a recommended setup step is left, the
 * settings dialog (and its devices and people sections), check-ins, theme, the
 * connection to your daemon in plain words with its latency, "N waiting for
 * you" (opens Work on those), what is running, and sign out. Admin and Providers are no longer pages: they are the Account and
 * Models and providers sections of the settings dialog.
 */
import { useState } from 'react';
import { BellRing, ChevronDown, History, ListChecks, LogOut, Settings, Smartphone, Sparkles, SunMoon, Users } from 'lucide-react';
import { useSetupChecklist } from '../settings/SetupChecklist';
import { useToastHistory, type ToastRecord } from '../../lib/toast';
import { Row, RowList } from '../ui/Row';
import { Sheet } from '../ui/Sheet';
import type { DaemonHealth } from '../../lib/daemon-health';
import { useTheme } from '../../hooks/useTheme';
import { formatShortcut } from '../../lib/shortcut-keys';
import { Menu, MenuCheckboxItem, MenuItem, MenuMeta, MenuRadioGroup, MenuSeparator } from '../ui/Menu';
import { StatusDot, type StatusTone } from '../ui/StatusDot';
import { Tooltip } from '../ui/Tooltip';

export type HealthSummary = Pick<
  DaemonHealth,
  'connection' | 'route' | 'working' | 'latencyMs' | 'sse' | 'activeTurns' | 'queuedTasks' | 'modelName'
>;

export function connectionTone(health: Pick<HealthSummary, 'connection' | 'working'>): StatusTone {
  if (health.connection === 'down') return 'bad';
  if (health.connection === 'reconnecting' || health.working === 'blocked') return 'warn';
  return 'ok';
}

/** "Connected to your daemon", never transport jargon (design doc "Plain words"). */
export function connectionPhrase(health: Pick<HealthSummary, 'connection' | 'route'>): string {
  if (health.connection === 'down') return 'Cannot reach your daemon';
  if (health.connection === 'reconnecting') return 'Reconnecting to your daemon';
  return health.route === 'relay' ? 'Connected to your daemon through the relay' : 'Connected to your daemon';
}

export function latencyPhrase(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 10) return '<10 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** `running` is the Work page's count of what is doing something now (lib/needs-you.ts runningNow). */
export function activityPhrase(health: Pick<HealthSummary, 'queuedTasks' | 'sse' | 'working'>, running: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (health.queuedTasks > 0) parts.push(`${health.queuedTasks} queued`);
  if (parts.length === 0) parts.push('Nothing running');
  const live: Record<HealthSummary['sse'], string> = {
    active: 'live updates on',
    connecting: 'live updates starting',
    error: 'live updates paused',
    disabled: 'live updates off',
    'relay-unsupported': 'no live updates over the relay',
  };
  parts.push(live[health.sse]);
  if (health.working === 'blocked') parts.push('this sign-in cannot read data');
  return parts.join(' · ');
}

function initialOf(name: string): string {
  const letter = name.trim().charAt(0);
  return letter ? letter.toUpperCase() : 'G';
}

export interface AccountMenuProps {
  name: string;
  health: HealthSummary;
  /** What Work counts as running right now. */
  running: number;
  /** What Work counts as waiting for you: shown first, and opens Work on those. */
  waiting: number;
  onReviewWaiting: () => void;
  /** Rail form: only the avatar shows; the name moves to a tooltip. */
  compact?: boolean;
  /** Open the settings dialog, on a section when one is named. */
  onOpenSettings: (section?: string) => void;
  onSignOut: () => void;
}

export function AccountMenu({ name, health, running, waiting, onReviewWaiting, compact = false, onOpenSettings, onSignOut }: AccountMenuProps) {
  const { theme, setTheme } = useTheme();
  const tone = connectionTone(health);
  const phrase = connectionPhrase(health);
  const latency = latencyPhrase(health.latencyMs);
  const accountLabel = `Account: ${name}. ${phrase}`;
  const notices = useToastHistory();
  // Recommended setup steps neither done nor skipped (Settings > General's checklist).
  const setupLeft = useSetupChecklist(false).left;
  const [noticesOpen, setNoticesOpen] = useState(false);

  return (
    <>
    <Menu
      label="Account"
      placement={compact ? 'right-start' : 'top-start'}
      width={280}
      trigger={(props) => {
        const button = (
          <button
            {...props}
            type="button"
            className={compact ? 'shell-account shell-account--compact' : 'shell-account'}
            aria-label={accountLabel}
          >
            <span className="shell-avatar" data-tone={tone} aria-hidden="true">{initialOf(name)}</span>
            {!compact && <span className="shell-account__name">{name}</span>}
            {!compact && <ChevronDown className="shell-account__chevron" aria-hidden="true" />}
          </button>
        );
        return compact
          ? <Tooltip content={name} placement="right" labelOnly>{button}</Tooltip>
          : button;
      }}
    >
      <MenuMeta>{name} · signed in on this browser</MenuMeta>
      {setupLeft > 0 && (
        <MenuItem icon={<ListChecks />} hint={`${String(setupLeft)} left`} onSelect={() => onOpenSettings('general')}>Finish setting up</MenuItem>
      )}
      <MenuItem icon={<Settings />} hint={formatShortcut('mod+,')} onSelect={() => onOpenSettings()}>Settings</MenuItem>
      <MenuItem icon={<Smartphone />} onSelect={() => onOpenSettings('devices')}>Devices and pairing</MenuItem>
      <MenuItem icon={<Users />} onSelect={() => onOpenSettings('people')}>People and channels</MenuItem>
      <MenuItem icon={<BellRing />} onSelect={() => onOpenSettings('checkins')}>Check-ins</MenuItem>
      <MenuItem icon={<History />} hint={notices.length > 0 ? String(notices.length) : undefined} onSelect={() => setNoticesOpen(true)}>Earlier notices</MenuItem>
      <MenuSeparator />
      <MenuRadioGroup
        icon={<SunMoon />}
        label="Theme"
        value={theme === 'neon' ? null : theme}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
          { value: 'auto', label: 'Auto' },
        ]}
        onChange={setTheme}
      />
      <MenuCheckboxItem icon={<Sparkles />} checked={theme === 'neon'} onChange={(on) => setTheme(on ? 'neon' : 'dark')}>
        GoodVibes Neon
      </MenuCheckboxItem>
      <MenuSeparator />
      <MenuItem
        icon={<StatusDot tone={tone} />}
        hint={latency || undefined}
        wrap
        onSelect={() => onOpenSettings('about')}
      >
        {phrase}
      </MenuItem>
      {waiting > 0 && (
        <MenuItem icon={<StatusDot tone="warn" />} onSelect={onReviewWaiting}>
          {waiting} waiting for you
        </MenuItem>
      )}
      <div role="none" className="gv-menu__text shell-account__activity">
        <span className="shell-account__spacer" aria-hidden="true" />
        <span>{activityPhrase(health, running)}</span>
      </div>
      {health.modelName && (
        <div role="none" className="gv-menu__text">
          <span className="shell-account__spacer" aria-hidden="true" />
          <span>Model <span className="shell-mono">{health.modelName}</span></span>
        </div>
      )}
      <MenuSeparator />
      <MenuItem icon={<LogOut />} onSelect={onSignOut}>Sign out</MenuItem>
    </Menu>
    <EarlierNotices open={noticesOpen} notices={notices} onClose={() => setNoticesOpen(false)} />
    </>
  );
}

const NOTICE_TONE: Record<ToastRecord['tone'], StatusTone> = { info: 'info', success: 'ok', warning: 'warn', danger: 'bad' };

/**
 * Every toast this page showed, newest first: a toast leaves the screen after a
 * few seconds (or when a sixth arrives), and what it said stays readable here
 * until the page is closed or another account signs in.
 */
function EarlierNotices({ open, notices, onClose }: { open: boolean; notices: readonly ToastRecord[]; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} label="Earlier notices">
      <h2 className="shell-notices__title">Earlier notices</h2>
      {notices.length === 0 ? (
        <p className="shell-notices__empty">Nothing has been said on this page yet.</p>
      ) : (
        <RowList aria-label="Earlier notices">
          {[...notices].reverse().map((notice) => (
            <Row
              key={notice.id}
              leading={<StatusDot tone={NOTICE_TONE[notice.tone]} />}
              title={notice.title}
              meta={`${new Date(notice.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${notice.description ? ` · ${notice.description}` : ''}`}
            />
          ))}
        </RowList>
      )}
    </Sheet>
  );
}
