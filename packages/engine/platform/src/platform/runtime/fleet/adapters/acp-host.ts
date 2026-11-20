/**
 * Hosted third-party ACP agent -> ProcessNode. A hosted Claude Code / Codex /
 * opencode session appears as a first-class fleet row: steerable (a steer is
 * the next ACP prompt) and stoppable (ACP cancel + kill). Its permission asks
 * are decided autonomously, so a hosted row never waits on a human.
 */
import type { AcpHostService, HostedAcpAgent } from '../../../acp/host.js';
import type { ProcessNode, ProcessState } from '../types.js';

export function acpHostNodeId(hostedId: string): string {
  return `acp:${hostedId}`;
}

function hostedState(hosted: HostedAcpAgent): ProcessState {
  switch (hosted.state) {
    case 'starting':
      return 'queued';
    case 'idle':
      return 'idle';
    case 'prompting':
      return 'executing-tool';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'killed';
  }
}

/** A failure first; then whichever came last of a refusal and the output tail. */
function activity(hosted: HostedAcpAgent, now: number): ProcessNode['currentActivity'] {
  if (hosted.error) return { kind: 'output-line', text: `${hosted.error.stage} failed: ${hosted.error.message}`, at: hosted.completedAt ?? now };
  const refusal = hosted.lastRefusal;
  if (refusal && (!hosted.progress || refusal.at >= (hosted.progressAt ?? 0))) {
    return { kind: 'output-line', text: `refused: ${refusal.reason}`.slice(0, 200), at: refusal.at };
  }
  return hosted.progress ? { kind: 'output-line', text: hosted.progress.slice(-200), at: hosted.progressAt ?? now } : undefined;
}

/** HostedAcpAgent -> ProcessNode. */
export function adaptHostedAcpAgent(hosted: HostedAcpAgent, now: number): ProcessNode {
  const state = hostedState(hosted);
  const live = hosted.state !== 'failed' && hosted.state !== 'stopped';
  return {
    id: acpHostNodeId(hosted.id),
    kind: 'acp-agent',
    serves: 'you',
    label: hosted.title,
    task: hosted.cwd,
    state,
    startedAt: hosted.startedAt,
    completedAt: hosted.completedAt,
    elapsedMs: Math.max(0, (hosted.completedAt ?? now) - hosted.startedAt),
    // Third-party agents do not report token usage over ACP session updates,
    // honest absence, never fabricated numbers.
    usage: undefined,
    costUsd: null,
    costState: 'unpriced',
    currentActivity: activity(hosted, now),
    capabilities: {
      interruptible: live,
      killable: live,
      pausable: false,
      resumable: false,
      // A live hosted session takes its next prompt as a steer, no message
      // bus involved; the host service delivers it over the ACP connection.
      steerable: live,
    },
    ...(hosted.sessionId ? { sessionRef: { sessionId: hosted.sessionId } } : {}),
    raw: hosted,
  };
}

/** Registry steer dispatch for an acp-agent node: the steer IS the next ACP prompt. */
export function steerHostedAcpNode(
  host: Pick<AcpHostService, 'prompt'> | undefined,
  node: ProcessNode,
  text: string,
): { queued: true; messageId: string } | { queued: false; reason: string } {
  const hosted = node.raw as HostedAcpAgent;
  if (!host) return { queued: false, reason: 'no ACP host service configured' };
  const result = host.prompt(hosted.id, text);
  return result.queued ? { queued: true, messageId: crypto.randomUUID() } : { queued: false, reason: result.reason };
}

/** Registry kill dispatch for an acp-agent node (fire-and-forget stop; the record flips synchronously). */
export function killHostedAcpNode(
  host: Pick<AcpHostService, 'stop'> | undefined,
  node: ProcessNode,
  onError: (id: string, error: unknown) => void,
): string[] {
  const hosted = node.raw as HostedAcpAgent;
  if (!host) return [];
  void host.stop(hosted.id).catch((error) => onError(hosted.id, error));
  return [node.id];
}
