import { join } from 'path';
import { ConversationManager } from '../core/conversation.js';
import { verificationHistory, verificationMessages } from '../core/verification/archive.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { openRecordLog, type RecordLog } from '../state/record-log.js';
import {
  type AtRestPolicy,
  DEFAULT_AT_REST_POLICY,
  AtRestLineWriter,
  enforceJournalDirectoryRetention,
} from '../runtime/at-rest-persistence.js';

/** The decision site the journal's credential span readings are logged under. */
const AGENT_JOURNAL_CREDENTIAL_SITE = 'agents.session.journal-credential-span';

export interface AgentSessionPaths {
  readonly sessionsDir: string;
  readonly stateDir: string;
}

function resolveAgentSessionPaths(paths: AgentSessionPaths): AgentSessionPaths {
  if (!paths.sessionsDir || paths.sessionsDir.trim().length === 0) {
    throw new Error('AgentSession requires a non-empty sessionsDir');
  }
  if (!paths.stateDir || paths.stateDir.trim().length === 0) {
    throw new Error('AgentSession requires a non-empty stateDir');
  }
  return paths;
}

/**
 * AgentSession, Isolated session context for a spawned agent.
 *
 * Each agent gets its own ConversationManager and JSONL message log file. The
 * log stays open for the run: a line is one write, and one background sync
 * covers every line written since the last.
 */
export class AgentSession {
  /** The agent's unique identifier. */
  readonly agentId: string;

  /** The open journal; null before the first line and after disposal. */
  private journal: RecordLog<string> | null = null;
  private journalClosed = false;

  /** Isolated conversation history for this agent. */
  readonly conversation: ConversationManager;

  /** Path to the agent's JSONL message log. */
  readonly sessionFile: string;

  /** The at-rest redaction + retention policy for this journal. */
  private readonly atRestPolicy: AtRestPolicy;

  /** Keeps journal lines in order while their credential spans are read. */
  private readonly lineWriter = new AtRestLineWriter(AGENT_JOURNAL_CREDENTIAL_SITE);
  private disposal: Promise<void> | undefined;
  /**
   * Journal lines that could not be written (a full disk, a permission error).
   * The run continues; a later history lookup finds no final conversation entry
   * and reports the journal as incomplete instead of "no history".
   */
  private lostWrites = 0;

  constructor(
    agentId: string,
    model: string,
    provider: string,
    paths: AgentSessionPaths,
    atRestPolicy: AtRestPolicy = DEFAULT_AT_REST_POLICY,
  ) {
    this.agentId = agentId;
    this.atRestPolicy = atRestPolicy;
    const resolvedPaths = resolveAgentSessionPaths(paths);

    // Retention enforcement point (checkpoint-gc lesson: gc that is never called
    // reclaims nothing). Each new agent journal prunes stale/oversized sibling
    // journals in the sessions dir before it starts writing its own.
    try {
      enforceJournalDirectoryRetention(resolvedPaths.sessionsDir, this.atRestPolicy);
    } catch (err) {
      logger.debug('AgentSession journal retention skipped', { agentId, error: summarizeError(err) });
    }

    // Own ConversationManager, not shared with main session
    this.conversation = new ConversationManager();

    // JSONL log path
    this.sessionFile = join(resolvedPaths.sessionsDir, `${agentId}.jsonl`);

    // The journal (and its directory) exists from construction, before any line is ready.
    this.journal = this._openJournal();

    // Write a session-start entry
    this.appendMessage({
      type: 'meta',
      agentId,
      model,
      provider,
      title: '',
      timestamp: Date.now(),
    });

    logger.debug('AgentSession created', { agentId, model, provider });
  }

  /**
   * Append a message record to the agent's JSONL log.
   * Each record is written as a single JSON line. With redaction on, a line
   * carrying a credential-shaped span that has not been read yet is written
   * once the span is read (engine.runtime.at-rest-credential), after every
   * line ahead of it; {@link flush} waits for those.
   */
  appendMessage(msg: Record<string, unknown>): void {
    try {
      const serialized = JSON.stringify(msg);
      if (this.atRestPolicy.redact) {
        this.lineWriter.write(serialized, (line) => this._appendLine(line));
      } else {
        this._appendLine(serialized);
      }
    } catch (err) {
      this.lostWrites += 1;
      logger.error('AgentSession.appendMessage failed', { agentId: this.agentId, error: summarizeError(err) });
    }
  }

  /** Resolves once every appended message is on disk. */
  flush(): Promise<void> {
    return this.lineWriter.flush();
  }

  /**
   * Clean up resources held by this session.
   * Flushes and disposes the KV state.
   */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    // Only native accepted messages enter this conversation. Private rejected
    // final drafts remain in their separate verification journal. Archives
    // preserve original observations through compaction, without promoting a
    // worker instruction or summary into an owner request or current approval.
    this.appendMessage({ type: 'agent_conversation', version: 1, agentId: this.agentId,
      messages: verificationMessages(this.conversation, this.conversation.getMessageSnapshot()),
      archive: verificationHistory(this.conversation), timestamp: Date.now() });
    this.disposal = (async () => {
      await this.flush();
      const journal = this.journal;
      this.journal = null;
      this.journalClosed = true;
      try {
        await journal?.flush();
      } catch (err) {
        this.lostWrites += 1;
        logger.error('AgentSession journal could not be synced', { agentId: this.agentId, error: summarizeError(err) });
      } finally {
        journal?.close();
      }
      if (this.lostWrites > 0) {
        logger.error('AgentSession disposed with an incomplete journal', { agentId: this.agentId, lostWrites: this.lostWrites, sessionFile: this.sessionFile });
      }
      logger.debug('AgentSession disposed', { agentId: this.agentId });
    })();
    return this.disposal;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _appendLine(line: string): void {
    try {
      if (!this.journalClosed) {
        (this.journal ??= this._openJournal()).append(line);
        return;
      }
      // A line that arrives after disposal still lands; the journal is not kept open for it.
      const late = this._openJournal();
      try { late.append(line); } finally { late.close(); }
    } catch (err) {
      this.lostWrites += 1;
      logger.error('AgentSession.appendMessage failed', { agentId: this.agentId, error: summarizeError(err) });
    }
  }

  private _openJournal(): RecordLog<string> {
    // Lines arrive already serialized (and redacted when the policy says so).
    return openRecordLog<string>(this.sessionFile, { fsync: 'batch', encode: (line) => line, decode: (line) => line });
  }
}
