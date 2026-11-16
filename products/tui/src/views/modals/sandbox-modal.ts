import type { ConfigModalAction, ConfigModalActionContext, ConfigModalRow, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { buildSandboxReview, listSandboxProfiles } from '@/runtime/index.ts';
import type { SandboxProfile, SandboxSession, SandboxSessionRegistry } from '@/runtime/index.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { toneStyle, statusGlyph, pad, postureLine, kv, type Tone } from './modal-surface-helpers.ts';

/** SandboxSessionRegistry has no event subscription, poll at the same 3s
 *  cadence the retired view used (POLL_INTERVAL_MS in the sandbox modal's earlier view). */
const POLL_INTERVAL_MS = 3_000;

function sessionTone(state: SandboxSession['state']): Tone {
  switch (state) {
    case 'running': return 'good';
    case 'failed': return 'bad';
    case 'planned': return 'warn';
    case 'stopped': return 'dim';
    default: return 'dim';
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}

function profileIdOf(row: ConfigModalRow | null): SandboxProfile['id'] | null {
  return row?.id.startsWith('profile:') ? (row.id.slice('profile:'.length) as SandboxProfile['id']) : null;
}

function sessionIdOf(row: ConfigModalRow | null): string | null {
  return row?.id.startsWith('session:') ? row.id.slice('session:'.length) : null;
}

/**
 * Sandbox config-modal surface (migrated from the `sandbox` view). All reads
 * (buildSandboxReview, listSandboxProfiles, sessions.list) are synchronous, so
 * buildView reads them live each tick. The earlier view's single profile+session
 * selectable list becomes two real tabs. s/x/e call the SandboxSessionRegistry
 * directly (these were never slash commands). start reports the session it
 * started (or why it could not start) and selects it on the Sessions tab;
 * execute reports the probe's exit status and first output line. The header
 * names the backend commands really run on and says when that is no isolation. execute is async: the key handler returns at once
 * and the probe's result lands in the status line when it finishes (5 s timeout).
 */
class SandboxModalSurface implements ConfigModalSurface {
  readonly name = 'sandbox-modal';
  readonly title = 'Sandbox';
  private requestRender: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: ConfigManager,
    private readonly sessions: SandboxSessionRegistry,
    requestRender: () => void = () => {},
  ) {
    this.requestRender = requestRender;
  }

  readonly actions: ConfigModalAction[] = [
    { key: 's', id: 'start', label: 'start', enabledFor: (row, tabId) => tabId === 'profiles' && profileIdOf(row) !== null },
    { key: 'x', id: 'stop', label: 'stop', confirm: true, enabledFor: (row, tabId) => tabId === 'sessions' && sessionIdOf(row) !== null },
    { key: 'e', id: 'execute', label: 'execute probe', enabledFor: (row, tabId) => tabId === 'sessions' && sessionIdOf(row) !== null },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    if (this.timer === null) this.timer = setInterval(() => this.requestRender(), POLL_INTERVAL_MS);
  }

  onClose(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  buildView(): ConfigModalView {
    try {
      const review = buildSandboxReview(this.config);
      const profiles = listSandboxProfiles(this.config);
      const sessions = this.sessions.list();

      const resolved = review.backendProbe?.resolvedBackend ?? 'local';
      const header = [
        postureLine([
          kv('platform', review.host.platform),
          kv('runs on', resolved),
          ...(review.config.vmBackend !== resolved ? [kv('configured', review.config.vmBackend)] : []),
          kv('sessions', sessions.length),
        ]),
        postureLine([review.host.secureSandboxReady
          ? 'isolated: commands run inside the sandbox backend'
          : 'NO ISOLATION: commands run as host processes; profiles below describe what each asks for, not what it gets']),
      ];

      const profileRows: ConfigModalRow[] = profiles.map((profile) => ({
        id: `profile:${profile.id}`,
        label: `${pad(profile.id, 14)} ${pad(profile.kind, 6)} asks for ${pad(profile.isolation, 10)}${profile.requiresVm ? ' in a VM' : ''}`,
      }));

      const sessionRows: ConfigModalRow[] = sessions.map((session) => ({
        id: `session:${session.id}`,
        label: `${statusGlyph(sessionTone(session.state))} ${pad(session.id, 20)} ${pad(session.state.toUpperCase(), 9)} backend=${pad(session.resolvedBackend ?? session.backend, 6)} runs=${session.executionCount ?? 0}`,
        style: toneStyle(sessionTone(session.state)),
      }));

      return {
        title: 'Sandbox',
        tabs: [
          { id: 'profiles', label: 'Profiles', header, rows: profileRows, emptyText: 'No sandbox profiles available.', hints: ['s start'] },
          { id: 'sessions', label: 'Sessions', header, rows: sessionRows, emptyText: 'No active sandbox sessions.', hints: ['x stop', 'e execute probe'] },
        ],
      };
    } catch (error) {
      return {
        title: 'Sandbox',
        degraded: `Sandbox posture unavailable: ${summarizeError(error)}`,
        tabs: [
          { id: 'profiles', label: 'Profiles', rows: [] },
          { id: 'sessions', label: 'Sessions', rows: [] },
        ],
      };
    }
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    switch (id) {
      case 'start': {
        const profileId = profileIdOf(ctx.row);
        if (!profileId) return;
        ctx.setStatus(`Starting a ${profileId} session…`);
        // start() either returns a usable session or rejects; there is no failed start to read from its state.
        void this.sessions.start(profileId, undefined, this.config)
          .then((session) => {
            ctx.setStatus(`Started ${session.id} (${session.resolvedBackend ?? session.backend}).`);
            ctx.jumpToRow?.('sessions', `session:${session.id}`);
          })
          .catch((error: unknown) => ctx.setStatus(`Start failed: ${summarizeError(error)}`))
          .finally(() => this.requestRender());
        return;
      }
      case 'stop': {
        const sessionId = sessionIdOf(ctx.row);
        if (!sessionId) return;
        const stopped = this.sessions.stop(sessionId);
        ctx.setStatus(!stopped ? `Session ${sessionId} no longer exists; nothing to stop.`
          : stopped.state === 'stopped' ? `Stopped ${sessionId}; it has left the list.`
          : `Released one holder of ${sessionId}; it keeps running for the others.`);
        break;
      }
      case 'execute': {
        const sessionId = sessionIdOf(ctx.row);
        if (!sessionId) return;
        // The probe runs in the background (up to its 5 s timeout) so the screen stays live; the result is shown when it ends.
        ctx.setStatus(`Running probe in ${sessionId}...`);
        // The same shell probe the registry starts a session with; the app's own executable is not a script runner.
        void this.sessions.execute(sessionId, 'bash', ['-lc', 'printf "sandbox probe ok"'], { timeoutMs: 5_000 })
          .then((result) => {
            const detail = firstLine(result.stdout) || firstLine(result.stderr);
            ctx.setStatus(`Probe ${result.status === 0 ? 'succeeded' : `failed (exit ${result.status ?? 'none'})`}${detail ? `: ${detail}` : ''}`);
          })
          .catch((error: unknown) => ctx.setStatus(`Probe failed: ${summarizeError(error)}`))
          .finally(() => this.requestRender());
        return;
      }
      default:
        return;
    }
    this.requestRender();
  }
}

export function createSandboxModalSurface(
  config: ConfigManager,
  sessions: SandboxSessionRegistry,
  requestRender: () => void = () => {},
): ConfigModalSurface {
  return new SandboxModalSurface(config, sessions, requestRender);
}
