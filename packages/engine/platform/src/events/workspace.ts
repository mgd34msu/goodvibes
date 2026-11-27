/**
 * WorkspaceEvent, discriminated union of the 'workspace' domain: list changes,
 * native request changes, rewinds and hunk reverts.
 *
 * Emitted under the 'workspace' domain on the RuntimeEventBus. The daemon has no
 * working directory a caller can move, so there is no swap event.
 */
import type { EventAbout } from './about.js';

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
        // Projects: a folder was registered as a project or let go; a project chooser reads the list again.
        | 'workspaces'
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
        | 'notes' | 'personas' | 'routines' | 'documents' | 'artifacts' | 'agent-homes'
        // Memory and knowledge: what is known about you written or edited by hand, a template deleted through the daemon.
        | 'profile' | 'templates'
        // Models and providers: a pin, a backup, the routing, a provider of your own, a sign-in or the services list changed through the daemon.
        | 'models' | 'services'
        // Devices and network: the network-scan decision changed, or the daemon's scan of your network finished.
        | 'network-scan'
        // Devices and network: a settings sync bundle pulled, or a setting that disagreed settled.
        | 'settings-sync'
        // Devices and network, and Secure address: this machine's group changed (from this machine or another), a group
        // was heard on the network, or the group's certificate changed.
        | 'machine-group'
        // This conversation: a model's context window size set or cleared through the daemon; every running program reads it again.
        | 'context-windows'
        // Code and changes: a build of the project's code index began or ended.
        | 'code-index'
        // Code and changes: a project's worktree register changed.
        | 'worktrees'
        // Mail, calendar and channels: the daemon's webhook addresses changed, or a notification failed.
        | 'notifications'
        // Mail, calendar and channels: the Google connection changed, or a step of connecting it began or ended.
        | 'google'
        // System: the daemon's update state changed (a check ended, an install began or ended, recovery needed).
        | 'system-updates'
        // System: the setup record changed (a checklist topic skipped or brought back, "Who decides" answered or put off).
        | 'setup'
        // System: a terminal program's own setting changed or was put back through the daemon.
        | 'settings'
        // Any place: a capability that changes something ran through capabilities.run (`id` is the capability's id), so a
        // list it acts on is read again whoever pressed it (the web view, the model, a script, another program).
        | 'capabilities';
      change: 'created' | 'changed' | 'deleted';
      id?: string | undefined;
      /** The project (its resolved folder) a per-project change is about; absent for a shared list. */
      project?: string | undefined;
      /** The session a per-session change is about; absent otherwise. */
      sessionId?: string | undefined;
      /** About a thing every project shares (runtime/list-changes.ts): every screen showing the list reads again. */
      shared?: true | undefined;
      /**
       * The record the change is about, declared by the daemon once it checked it (about.ts): a checkpoint and the project
       * whose store holds it. The stream filter delivers the notice by it.
       */
      about?: EventAbout | undefined;
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
