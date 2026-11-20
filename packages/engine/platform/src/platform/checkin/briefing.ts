/**
 * checkin/briefing.ts
 *
 * Turns a state snapshot into the compact briefing the model judges. Pure and
 * deterministic so it is testable without any live services, the daemon binds
 * a CheckinStateReader to the real sessions/channels/automation, and this
 * renders whatever that reader returns.
 */
import type { CheckinStateSnapshot } from './types.js';

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * A one-line summary of the snapshot, reused in receipts: what waits for the
 * owner (the same count the check-in's decision reads), then only the other
 * counts that are not zero.
 */
export function summarizeCheckinState(snapshot: CheckinStateSnapshot): string {
  const waiting = snapshot.waitingForOwner;
  const parts = [
    waiting === undefined ? '' : waiting === 0 ? 'Nothing waiting for you' : `${counted(waiting, 'item', 'items')} waiting for you`,
    snapshot.runningSessions > 0 ? `${counted(snapshot.runningSessions, 'session', 'sessions')} running` : '',
    snapshot.blockedSessions > 0 ? `${counted(snapshot.blockedSessions, 'session has', 'sessions have')} messages not yet picked up` : '',
    snapshot.unreadChannelItems > 0 ? `${counted(snapshot.unreadChannelItems, 'channel message', 'channel messages')} not yet picked up` : '',
    snapshot.recentCompletions > 0 ? `${counted(snapshot.recentCompletions, 'run', 'runs')} finished recently` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join('; ')}.` : 'Nothing running and nothing waiting.';
}

/** The compact briefing text handed to the judge. */
export function assembleCheckinBriefing(snapshot: CheckinStateSnapshot): string {
  const lines: string[] = [
    'Current state:',
    `- Running sessions: ${snapshot.runningSessions}`,
    `- Sessions with the owner's messages not yet picked up: ${snapshot.blockedSessions}`,
    `- Channel messages not yet picked up: ${snapshot.unreadChannelItems}`,
    `- Recent completions: ${snapshot.recentCompletions}`,
  ];
  if (snapshot.needsAttention.length > 0) {
    lines.push('- Needs attention:');
    for (const item of snapshot.needsAttention) lines.push(`  - ${item}`);
  } else {
    lines.push('- Needs attention: none');
  }
  return lines.join('\n');
}
