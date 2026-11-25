/**
 * safety-sources.ts, what Permissions and safety (safety-place.ts) reads in a terminal program: this conversation's
 * permissions and plan mode, and the sandbox sessions this program started, with the list a "Sandbox session" input
 * chooses from. Only the terminal programs import it (places/index.ts), so the place's declaration stays data a
 * browser loads (places/browser.ts).
 */
import type { SessionCapabilityServices } from '../agent-turn/capability-tools.js';
import { SANDBOX_SESSIONS_LIST } from '@goodvibes/engine/platform/platform/capabilities';
import type { SandboxSessionRegistry } from '@goodvibes/engine/platform/platform/runtime/sandbox';
import { defineList, type ListRow } from '../command-actions/lists.js';
import type { CommandActionContext } from '../command-actions/types.js';
import type { PlaceProgramSource } from './place-host.js';
import type { SafetyItem } from './safety-place.js';

interface SandboxSessionsHolder {
  readonly workspace?: { readonly sandboxSessionRegistry?: Pick<SandboxSessionRegistry, 'list'> | null | undefined } | undefined;
}

/** The sandbox sessions this program started: the list a "Sandbox session" input chooses from (only the terminal app keeps them). */
defineList<CommandActionContext>({
  name: SANDBOX_SESSIONS_LIST,
  async read(ctx) {
    const registry = (ctx as CommandActionContext & SandboxSessionsHolder).workspace?.sandboxSessionRegistry;
    if (!registry) return [];
    return registry.list().map((session): ListRow => ({
      value: session.id, label: session.label || session.profileId, detail: `${session.profileId} · ${session.backend}`, state: session.state,
    }));
  },
  operator: { terminalOnly: 'Sandbox sessions belong to the terminal app that started them.' },
});

/** Text from another process or a file, with control characters taken out before it is drawn. */
const plain = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() : '';

/** The two program sources this place reads: this conversation, and the sandbox sessions this program started. */
export function safetyPlaceSources(services: (() => SessionCapabilityServices | undefined) | undefined): Readonly<Record<string, PlaceProgramSource>> {
  const conversation: PlaceProgramSource = {
    read: () => {
      const live = services?.();
      const items: SafetyItem[] = [];
      const here = live?.permissionsHere;
      if (here) {
        const words = here.modeWords();
        items.push({
          id: 'conversation-permission-mode', state: 'mode', fill: '', title: 'When GoodVibes asks',
          right: words.inForce ? words.inForce : words.chosen, mark: words.inForce ? 'attention' : 'ok',
          lines: [
            { label: 'Chosen', text: words.chosen },
            ...(words.inForce ? [{ label: 'In force now', text: words.inForce, tone: 'warning' as const }, ...(words.because ? [{ label: 'Because', text: words.because }] : [])] : []),
            { text: words.sentence },
            { text: 'Change it in Settings, When GoodVibes asks.', tone: 'muted' },
          ],
        });
      }
      const plan = live?.planMode;
      if (plan) {
        const on = plan.isOn();
        items.push({
          id: 'conversation-plan-mode', state: on ? 'on' : 'off', fill: '', title: 'Plan mode', right: on ? 'on' : 'off', mark: on ? 'running' : 'paused',
          lines: [{ text: on ? 'Writes, commands and network calls are blocked in this conversation.' : `Off: the mode is ${plan.modeLabel()}.` }],
        });
      }
      return items;
    },
    // Read again on every read of the place (after each action); a mode changed with Shift+Tab shows on the next read.
    subscribe: () => () => {},
  };
  const sandbox: PlaceProgramSource = {
    read: () => {
      const held = services?.()?.sandboxSessions;
      if (!held) return [];
      return held.registry.list().map((session): SafetyItem => ({
        id: session.id, state: session.state, fill: session.id, title: plain(session.label) || session.profileId,
        right: session.state, mark: session.state === 'running' ? 'running' : 'paused',
        lines: [
          { label: 'Profile', text: session.profileId },
          { label: 'Boundary', text: session.backend },
          ...(session.lastCommandSummary ? [{ label: 'Last ran', text: plain(session.lastCommandSummary) }] : []),
        ],
      }));
    },
    subscribe: () => () => {},
  };
  return { 'safety-conversation': conversation, 'safety-sandbox': sandbox };
}
