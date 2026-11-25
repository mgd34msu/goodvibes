/**
 * Plan mode: this conversation plans without changing anything (writes,
 * commands and network calls are blocked) while the saved mode stays as it
 * is. It belongs to the program holding the conversation, which keeps the
 * mode it was in before so turning plan mode off puts that one back.
 */
import { CapabilityRefusal, type CapabilityDefinition } from '../types.js';

/** What the plan mode capabilities need from the program holding the conversation. */
export interface PlanModeSessionServices {
  readonly planMode?: {
    isOn(): boolean;
    /** The mode in force, as a person reads it ("Ask me"). */
    modeLabel(): string;
    /** Turn plan mode on, remembering the mode to go back to. */
    turnOn(): void;
    /** Turn plan mode off; answers the mode in force afterwards, as a person reads it. */
    turnOff(): string;
  } | undefined;
}

/** Only the program that keeps a plan mode toggle offers these (the terminal app). */
function hasPlanMode(services: PlanModeSessionServices): boolean {
  return services.planMode !== undefined;
}

function planMode(services: PlanModeSessionServices): NonNullable<PlanModeSessionServices['planMode']> {
  if (!services.planMode) throw new CapabilityRefusal('Plan mode is not available in this program.');
  return services.planMode;
}

export const PLAN_STATUS: CapabilityDefinition<PlanModeSessionServices> = {
  capability: { id: 'plan.status', group: 'safety', home: 'session', repeat: 'safe' }, available: hasPlanMode,
  actionId: 'status', label: 'See whether plan mode is on', word: 'status', inputs: [],
  sentence: 'Says whether plan mode is on, and the mode in force.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const plan = planMode(services);
    const on = plan.isOn();
    return {
      text: on ? 'Plan mode is on: writes, commands and network calls are blocked.' : `Plan mode is off; the mode is ${plan.modeLabel()}.`,
      data: { on },
    };
  },
};

export const PLAN_ON: CapabilityDefinition<PlanModeSessionServices> = {
  capability: { id: 'plan.on', group: 'safety', home: 'session', repeat: 'safe' }, available: hasPlanMode,
  actionId: 'on', label: 'Turn plan mode on', word: 'on', inputs: [],
  sentence: 'Writes, commands and network calls are blocked for this session only; your saved mode is not changed.', done: '',
  touches: 'this-machine', lasts: 'session', risk: 'none', undoneBy: 'off', tightens: true, example: {},
  async run(_values, services) {
    const plan = planMode(services);
    if (plan.isOn()) return { text: 'Plan mode is already on; nothing changed.', data: { on: true } };
    plan.turnOn();
    return { text: 'Plan mode is on: writes, commands and network calls are blocked until you turn it off (or press Shift+Tab).', data: { on: true } };
  },
};

export const PLAN_OFF: CapabilityDefinition<PlanModeSessionServices> = {
  capability: { id: 'plan.off', group: 'safety', home: 'session', repeat: 'safe' }, available: hasPlanMode,
  actionId: 'off', label: 'Turn plan mode off', word: 'off', inputs: [],
  sentence: 'Writes, commands and network calls are allowed again under the mode you had before, for this session only.', done: '',
  touches: 'this-machine', lasts: 'session', risk: 'loosens-a-protection', undoneBy: 'on',
  ownerOnly: { reason: 'leaving plan mode lets the session change things again', instead: 'Ask the owner to turn plan mode off (Permissions and safety, or Shift+Tab).' },
  example: {},
  async run(_values, services) {
    const plan = planMode(services);
    if (!plan.isOn()) return { text: `Plan mode is not on; the mode stays ${plan.modeLabel()}.`, data: { on: false } };
    return { text: `Plan mode is off; the mode is ${plan.turnOff()}.`, data: { on: false } };
  },
};
