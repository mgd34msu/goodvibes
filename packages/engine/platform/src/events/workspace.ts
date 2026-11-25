/**
 * WorkspaceEvent, discriminated union covering workspace swap lifecycle events.
 *
 * Emitted under the 'workspace' domain on the RuntimeEventBus.
 * Subscribers can react to working-directory changes without polling config.
 */

export type WorkspaceEvent =
  /**
   * A list a client shows changed (runtime/list-changes.ts): a memory record,
   * a workspace checkpoint, a CI watch, a check-in setting or receipt, a person
   * or device in the people list, the mailbox, the calendar, dates, paired
   * devices, delegated Telegram messages, the local voice install, Tailscale,
   * the daemon's remote runners. A view showing that list reads it again.
   */
  | {
      type: 'LIST_CHANGED';
      list: 'memory' | 'checkpoints' | 'ci-watches' | 'check-ins' | 'people'
        | 'mail' | 'calendar' | 'dates' | 'paired-devices' | 'telegram-intake' | 'voice' | 'tailscale' | 'relay'
        | 'remote-runners'
        // Work and agents: a research run or a research source changed, or work was handed to the terminal app.
        | 'research' | 'handed-off'
        // The hook trace: a hook ran in any program.
        | 'hook-trace'
        // Tools and extensions: the hooks file, a tool server's config, a plugin or an install changed through the daemon.
        | 'tools'
        // Automation: a trigger made, stopped, started again or changed state, or a command triggers may run.
        | 'triggers'
        // Permissions and safety: a permission rule, a secret, a folder's trust, a local sign-in, the policy or the sandbox.
        | 'safety'
        // Money: a card added or removed, a repeat purchase allowed or stopped, a billing or shipping address set.
        | 'payments'
        // Money: the daemon recorded what a model call cost.
        | 'spending'
        // Memory and knowledge: a note, persona, routine, draft or saved artifact changed through the daemon.
        | 'notes' | 'personas' | 'routines' | 'documents' | 'artifacts'
        // Memory and knowledge: what is known about you written or edited by hand, a template deleted through the daemon.
        | 'profile' | 'templates'
        // Models and providers: a pin, a backup, the routing, a provider of your own, a sign-in or the services list changed through the daemon.
        | 'models' | 'services'
        // Devices and network: the network-scan decision changed, or the daemon's scan of your network finished.
        | 'network-scan'
        // Devices and network: a settings sync bundle pulled, or a setting that disagreed settled.
        | 'settings-sync'
        // This conversation: a model's context window size set or cleared through the daemon; every running program reads it again.
        | 'context-windows'
        // Mail, calendar and channels: the daemon's webhook addresses changed, or a notification failed.
        | 'notifications';
      change: 'created' | 'changed' | 'deleted';
      id?: string | undefined;
    }
  /**
   * A native request changed: a write to it committed (its capture, a host
   * decision, admission or cancellation in `intake`; its work or attempts in
   * `work-ledger`; its run, settlement or CI continuation in `execution`). A
   * view showing native requests reads them again; nothing else is carried.
   */
  | {
      type: 'NATIVE_REQUEST_CHANGED';
      projectId: string;
      store: 'intake' | 'work-ledger' | 'execution';
    }
  /** Emitted when the daemon begins to move to another working directory (every service stops and starts again there). */
  | {
      type: 'WORKSPACE_SWAP_STARTED';
      from: string;
      to: string;
    }
  /**
   * Emitted by the daemon once it serves on the new working directory after a
   * move, or, on a host that cannot move, once the change is saved for its next start.
   */
  | {
      type: 'WORKSPACE_SWAP_COMPLETED';
      from: string;
      to: string;
      /** True if the new path was persisted to daemon-settings.json. */
      persistedInDaemonSettings: boolean;
    }
  /** Emitted when a change is refused because the daemon is already moving. */
  | {
      type: 'WORKSPACE_SWAP_REFUSED';
      from: string;
      to: string;
      /** Human-readable reason string. */
      reason: string;
      /** Suggested retry delay in seconds. */
      retryAfter: number;
    }
  /**
   * Emitted when a working-directory change fails: the path could not be
   * created or saved, or a move failed and the daemon started again on its
   * previous root.
   * Any subscriber that saw WORKSPACE_SWAP_STARTED without a subsequent
   * WORKSPACE_SWAP_COMPLETED should watch for this event.
   */
  | {
      type: 'WORKSPACE_SWAP_FAILED';
      /** Original working directory (swap source). */
      from: string;
      /** Target path that was attempted. */
      to: string;
      /** Machine-readable failure code. */
      code: 'INVALID_PATH' | 'REROOT_FAILED' | 'UNKNOWN';
      /** Human-readable reason. */
      reason: string;
    }
  /**
   * A unified rewind was PREVIEWED (rewind.plan), a surface can render that a
   * rewind to this turn anchor is staged and awaiting confirmation. Read-only:
   * nothing has changed yet.
   */
  | {
      type: 'REWIND_PLANNED';
      sessionId: string;
      /** The turn boundary rewound to, or null for the session's most recent checkpoint. */
      turnId: string | null;
      scope: 'files' | 'conversation' | 'both';
    }
  /**
   * A unified rewind was APPLIED (rewind.apply), the receipt surfaces render.
   * `undoAvailable` is true when the apply recorded an undo point (a pre-restore
   * safety checkpoint and/or a captured conversation snapshot) so the rewind can
   * be reversed.
   */
  | {
      type: 'REWIND_APPLIED';
      sessionId: string;
      turnId: string | null;
      scope: 'files' | 'conversation' | 'both';
      filesRestored: boolean;
      conversationRewound: boolean;
      undoAvailable: boolean;
    }
  /**
   * A single unified-diff hunk was reverse-applied to its file in the working
   * tree (checkpoints.revertHunk), the per-hunk counterpart to a whole-checkpoint
   * restore. `undoAvailable` is true when a pre-revert whole-tree safety
   * checkpoint was recorded (restore it to reverse the revert).
   */
  | {
      type: 'HUNK_REVERTED';
      /** The workspace-relative file path whose hunk was reverted. */
      path: string;
      /** The `@@ … @@` header of the reverted hunk. */
      hunkHeader: string;
      /** Session this revert was attributed to, when the caller supplied one; null otherwise. */
      sessionId: string | null;
      /** The pre-revert safety checkpoint id, or null when the tree already matched the latest checkpoint. */
      safetyCheckpointId: string | null;
      undoAvailable: boolean;
    };

export type WorkspaceEventType = WorkspaceEvent['type'];
