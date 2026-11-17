/**
 * How the host tells a running sub-agent something between its model requests
 * (the owner's answer to a question it asked).
 *
 * The runner opens an inlet once the agent's conversation exists and closes it
 * the moment the run decides to end, so text handed to an agent that is ending
 * or gone is refused at once instead of left where no request will read it.
 * Handed text rides the agent's next model request on its host channel
 * (`replay`, sent once). A run whose model gave its final reply while handed
 * text was still unread takes one more turn, so the agent acts on it.
 */
import type { HostInstructions } from '../core/host-instructions.js';

interface OpenInlet {
  readonly host: HostInstructions;
  readonly running: () => boolean;
  /** Texts handed in so far. */
  handed: number;
  /** Texts carried by a request the provider accepted. */
  read: number;
}

const inlets = new Map<string, OpenInlet>();

export interface AgentInlet {
  /** Call just before a model request is built; pass the mark to `accepted` once the provider took it. */
  beforeRequest(): number;
  accepted(mark: number): void;
  /** Text was handed in that no accepted request has carried yet. */
  unread(): boolean;
  /** Takes no more text; a later hand-in is refused. */
  close(): void;
}

/** Opens the run's inlet. `running` says whether the run still reads requests (its record reads running). */
export function openAgentInlet(agentId: string, host: HostInstructions, running: () => boolean): AgentInlet {
  const inlet: OpenInlet = { host, running, handed: 0, read: 0 };
  inlets.set(agentId, inlet);
  return {
    beforeRequest: () => inlet.handed,
    accepted: (mark) => { if (mark > inlet.read) inlet.read = mark; },
    unread: () => inlet.handed > inlet.read,
    // A later run of the same agent (a wake) has its own inlet, which this one never closes.
    close: () => { if (inlets.get(agentId) === inlet) inlets.delete(agentId); },
  };
}

/** Hands text to a running agent's next model request. False when the agent is not running or is finishing. */
export function tellRunningAgent(agentId: string, text: string): boolean {
  const inlet = inlets.get(agentId);
  if (!inlet || !inlet.running()) return false;
  inlet.host.set('replay', text, { once: true, append: true });
  inlet.handed += 1;
  return true;
}
