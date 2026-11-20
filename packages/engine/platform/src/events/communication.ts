/**
 * CommunicationEvent, typed runtime events for structured agent communication.
 */

export type CommunicationKind =
  | 'directive'
  | 'status'
  | 'question'
  | 'finding'
  | 'review'
  | 'handoff'
  | 'escalation'
  | 'completion'
  /**
   * Steering (see CHANGELOG 0.38.0): an operator (human)-originated message queued for a
   * live in-process agent via `ProcessRegistry.steer()`. Framed verbatim as
   * a user turn at the drain site (orchestrator-runner.ts), not wrapped in
   * the `[Kind from sender]` inter-agent directive framing.
   */
  | 'steer';

export type CommunicationScope = 'direct' | 'broadcast';

export type CommunicationEvent =
  /**
   * An agent sent a message to another agent (`scope: 'direct'`, `toId` the
   * recipient) or to every agent (`scope: 'broadcast'`, `toId` `*`). `kind`
   * says what it is (a directive, a question, a finding, a handoff...), and
   * `content` is its text. Role, cohort, contract and parent fields carry the
   * routing the message was sent under.
   */
  | {
      type: 'COMMUNICATION_SENT';
      messageId: string;
      fromId: string;
      toId: string;
      scope: CommunicationScope;
      kind: CommunicationKind;
      content: string;
      fromRole?: string | undefined;
      toRole?: string | undefined;
      cohort?: string | undefined;
      contractId?: string | undefined;
      parentAgentId?: string | undefined;
    }
  /**
   * The recipient took a sent message into one of its turns. A message
   * waiting for a long turn to end has been sent, not yet delivered.
   */
  | {
      type: 'COMMUNICATION_DELIVERED';
      messageId: string;
      fromId: string;
      toId: string;
      scope: CommunicationScope;
      kind: CommunicationKind;
    }
  /**
   * A message was not sent: the sender is not a registered agent, the
   * recipient is unknown, or the communication policy refused it (an agent
   * may only talk along its communication lane). `reason` says which.
   */
  | {
      type: 'COMMUNICATION_BLOCKED';
      messageId: string;
      fromId: string;
      toId: string;
      scope: CommunicationScope;
      kind: CommunicationKind;
      reason: string;
      fromRole?: string | undefined;
      toRole?: string | undefined;
      cohort?: string | undefined;
      contractId?: string | undefined;
      parentAgentId?: string | undefined;
    }
  | {
      /**
       * The agent `agentId` took a queued message into its conversation at
       * turn `turn`. Emitted once, where the agent's inbox is drained at a turn
       * boundary (orchestrator-runner's per-turn inbox drain).
       */
      type: 'COMMUNICATION_CONSUMED';
      messageId: string;
      agentId: string;
      turn: number;
    };

export type CommunicationEventType = CommunicationEvent['type'];
