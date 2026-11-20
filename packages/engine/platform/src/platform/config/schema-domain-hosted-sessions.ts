/**
 * Daemon-hosted session configuration.
 *
 * The engine lives in platform/hosted-sessions; this file is only its settings
 * surface. It is its own domain rather than another block inside
 * schema-domain-runtime.ts because that file is at its size ceiling.
 *
 * `detachPolicy` is the one people will actually change, and its default is
 * deliberate: `kill`. Detaching a client has always ended its work, everyone
 * expects that, and a capability landing must not silently redefine a familiar
 * action. Setting `survive` opts an installation into sessions that outlive the
 * client that opened them; a single session can also override the setting when
 * it is created.
 */
import { intRange, type ConfigSettingDefinition } from './schema-shared.js';

export interface HostedSessionsSettings {
  detachPolicy: 'kill' | 'survive';
  maxSessions: number;
  maxMessagesPerSession: number;
  terminatedRetentionMs: number;
  /**
   * How long a client's attachment stands without renewal, in milliseconds.
   * An attachment is a claim about a live process; a client that crashed or
   * closed its tab makes no detach call, so the claim has to expire or a
   * kill-policy session waits for a departure that never arrives.
   */
  attachmentTtlMs: number;
  /**
   * Whether a surface that receives inbound channel messages hands the
   * conversation to the daemon to host instead of answering it in its own
   * process. Off by default: today an inbound message is answered by the
   * process that received it, and that is what people's channels already do.
   */
  promoteInboundConversations: boolean;
  /**
   * Whether the agent's OWN conversation turns run in the connected daemon
   * rather than in the agent process. Off by default: the agent's turn is
   * composed in the agent process (its prompt, persona, skills, memory and
   * tools), and work that must outlive the terminal reaches the daemon through
   * /work, channels and schedules. On: a turn keeps running when the agent
   * process goes away, with the daemon's own prompt and tools.
   *
   * Distinct from {@link promoteInboundConversations}, which is about messages
   * arriving from a channel. This one is about what happens when the person in
   * front of this surface presses enter.
   */
  routeConversationTurns: boolean;
}


export const hostedSessionsConfigDefaults = {
  hostedSessions: {
    detachPolicy: 'kill',
    maxSessions: 8,
    maxMessagesPerSession: 500,
    terminatedRetentionMs: 24 * 60 * 60_000,
    attachmentTtlMs: 10 * 60_000,
    promoteInboundConversations: false,
    routeConversationTurns: false,
  },
};

export const hostedSessionsConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'hostedSessions.detachPolicy',
    label: 'What happens to a daemon session when its last window closes',
    type: 'enum',
    description: 'What happens to a daemon-hosted session when its last client detaches. kill (default): the session ends, which is what closing a client has always done. survive: the session stays alive and reattachable, so work continues while nothing is watching and you can pick it up again from any surface. A single session can override this when it is created.',
    enumValues: ['kill', 'survive'],
  },
  {
    key: 'hostedSessions.maxSessions',
    label: 'Most daemon sessions at once',
    type: 'number',
    description: 'How many daemon-hosted sessions may be live at once. Creating one past this is refused with the count and this setting named, rather than accepted and starved. Terminated sessions do not count.',
    ...intRange(1, 1_000),
  },
  {
    key: 'hostedSessions.maxMessagesPerSession',
    label: 'Messages saved per daemon session',
    type: 'number',
    description: 'How many of a hosted session\'s most recent messages are written to disk. The transcript in memory is unaffected; this bounds what a restart can restore, so one long conversation cannot grow its file without limit.',
    ...intRange(1, 100_000),
  },
  {
    key: 'hostedSessions.terminatedRetentionMs',
    label: 'Keep ended daemon sessions for (ms)',
    type: 'number',
    description: 'How long a terminated hosted session\'s record and transcript are kept before they are retired, in milliseconds. Until then the session is still listable with its termination reason, and its transcript (its reply included) stays readable with sessions.hosted.history by the client that created it, also after a daemon restart.',
    ...intRange(0, 31_536_000_000),
  },
  {
    key: 'hostedSessions.attachmentTtlMs',
    label: 'How long a silent window stays attached (ms)',
    type: 'number',
    description: 'How long a client stays attached to a daemon-hosted session without renewing, in milliseconds. Attaching again renews it, and a client whose control-plane connection is still open renews automatically. A client that crashed or closed its tab never detaches, so without this its attachment stands forever and a kill-policy session waits for a departure that never comes. When the last attachment lapses the session is treated as detached, and hostedSessions.detachPolicy decides what happens next. Between 30 seconds and a day.',
    ...intRange(30_000, 86_400_000),
  },
  {
    key: 'hostedSessions.promoteInboundConversations',
    label: 'Let the daemon answer chat-app conversations',
    type: 'boolean',
    description: 'Hand inbound channel conversations to the daemon to host, instead of answering them inside the surface process that received them. Off (default): a message from Telegram, Slack, email or any other channel is answered by that process, and it stops when the process stops. On: the first message of a conversation creates a daemon-hosted session and every later message is steered into it, so the conversation keeps its context and keeps running while no surface is open. What happens when the last client leaves is still hostedSessions.detachPolicy.',
  },
  {
    key: 'hostedSessions.routeConversationTurns',
    label: "Run the Agent's turns on the daemon",
    type: 'boolean',
    description: 'Only goodvibes-agent reads this; the terminal product (goodvibes) always runs turns in its own process. Off (the default): the agent\'s conversation turns run in the agent process, with the agent\'s own prompt, persona, skills, memory and tools; work that must outlive the terminal goes to the daemon through /work, channels and schedules. On: with a connected daemon reachable, the first message of a conversation creates a daemon-hosted session rooted at this surface\'s working directory and every later message is steered into it, so the turn survives this process closing; that hosted turn is still an Agent turn, with the agent\'s operator policy, persona, skills, routines, memory and its profile, occasions, artifact, document, research-run, research-source, review-packet, media, notify and work-plan tools, while the agent tools that run only in this process are named to the model and refused there. With no connected daemon reachable the turn runs locally regardless, and the transcript says so in one line naming the reason.',
  },
];
