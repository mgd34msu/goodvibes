# Session durability

GoodVibes TUI keeps two copies of a conversation on disk: the saved session and, only while the
conversation holds something the saved session does not, a crash snapshot.

## Saved session

After every completed assistant turn (`TURN_COMPLETED`), `persistConversation` writes the whole
conversation through `SessionManager` (one temp file, one rename). This is the copy `/session
resume`, `--continue`, `--resume` and the session browser read. The first line of the file carries
the session's title, model and message count, so listing sessions reads one line per file.

Saved sessions are kept until you delete them. The start-up retention sweep that bounds agent
journals, logs and crash snapshots (`atRest.retentionMaxAgeDays`, `atRest.retentionMaxTotalMb`) never removes
a saved conversation, whether it was saved at turn end or with `/session save`.

## Crash snapshot

The crash snapshot (`writeRecoveryFile`) is written, each time only when the conversation changed
since its last write:

- when a prompt is accepted (`TURN_SUBMITTED`), so the message survives a kill during the stream;
- after a batch of tool calls (`TOOLS_DONE`), so a kill mid-turn keeps the tool work done so far; batches
  are written at most once every five seconds (a batch inside that window is written when it ends, and
  dropped once the turn completes, since the turn-end save is the copy then);
- when the save at the end of a turn fails, so that turn is not lost;
- for a change made outside a turn (`/undo`, `/title`, a branch switch), at most once a minute
  (`src/runtime/recovery-autosave.ts`);
- on a signal, a crash or a quit, before the save at exit runs, so a quit that misses its deadline
  keeps what was not yet saved.

The turn-time writes live in `src/core/turn-event-wiring.ts` and follow the rule both terminal apps
share (`writeCrashSnapshotAtTurnMoments`). It is deleted when the save at the end of a turn
succeeds and when a quit's save succeeds, so a snapshot on disk always holds something the saved
session does not. An idle session writes nothing.

## Which session is open where

A session is identified by its saved file, which names the app (`tui`, `agent`), the project it lives
in and the session id: a TUI session and an Agent session saved under the same name, or two
projects' sessions with one name, are different sessions. The path is taken in canonical form (the
sessions folder's real path, resolved once per process), so a project reached through a symlink or
another spelling of its folder is still the same session; a question recorded under another spelling
is compared in the same canonical form and still reaches the session. The owner inbox records that file on every
question a session asks and delivers the answer only to that session; a question recorded before the
file was kept is matched by its session id, as it always was.

A terminal that has a session open holds that session's lock: an empty file under
`~/.goodvibes/shared/owner-askers/`, locked with an operating-system lock that is released when the
process ends, however it ends. It is taken when the session becomes the live one and moves when the
session id moves (a resume, a fork, `/session save <name>`, a recovery restore); a clean close
removes the file while still holding it. Nothing refreshes it and no process id or age is compared,
so a crashed terminal never reads as open and a crash relaunched at once is offered at once. The
owner inbox reads the same lock to tell whether the session that asked a question is open now.

Two things read it: `/resume` and the session browser refuse (or, in
the browser, ask before resuming) a session another running terminal has open, and the recovery
offer skips a snapshot whose session another running terminal has open, since it is that
terminal's live state. Reading it costs one `stat` and, when the file exists, one lock attempt
that never waits. The start-up housekeeping removes lock files a crashed process left.

## Recovering a crash snapshot

On the next start the TUI offers the newest snapshot that is not older than its session's own
saved file, skipping one whose session another running terminal has open. The same offer is made
whenever a session is opened later by any path (`--continue`, `--resume`, `sessions resume`,
`/resume`, the session browser) and that session has a snapshot newer
than its saved file: the saved copy is opened, and the snapshot is offered on top of it. A session
that crashed before its first save has only the snapshot; opening it says so and offers the
snapshot. Choosing Remove deletes that one snapshot; a later crash of the same session is offered
again.

Restoring a snapshot that ends inside a turn records that turn as interrupted; it is never run
again on its own:

- the prompt of that turn is kept and marked cancelled, as Esc marks a cancelled prompt;
- the tool results the turn had already obtained are kept as they were;
- a reply that was still arriving keeps its text, followed by a line saying it was cut off; every
  snapshot records the moment it was taken (prompt accepted, a tool batch done, the minute timer,
  exit) and whether a reply was still arriving, so a cut-off reply is never shown as a finished one;
- a tool call the model had made whose result never reached disk gets a result that says it was
  interrupted and that its effect is unknown (outcome `cancelled`), never a success;
- the next prompt you send continues from there.

The receipt line says what came back (messages, prompts, the interrupted prompt and its tool
results, the tool calls recorded as interrupted) and what could not: model output still arriving
after the snapshot was written, and tool calls started after it.

A kill at any moment loses at most the streaming text of the turn in flight and any tool calls of
that turn that had not finished. A completed turn is never lost.

## Side branches left out of a restore

A saved side branch (made with `/session branch`) that this version cannot read is left out of a resume or
crash restore, and the transcript names it and the reason. The rest of the session is restored;
the next save of that session is written without the branch.

### `--continue` with no last-session pointer

If a session was killed before the first snapshot was written (i.e., no last-session pointer
exists), `--continue` and a bare `--resume` print "No previous conversation to continue. This is
a new one; /session list shows saved ones." in the transcript and then start as a plain launch
would: first run when the model is not ready yet, otherwise a fresh conversation. **Recovery path:** the startup recovery
modal (see "The startup recovery modal" in [getting-started.md](getting-started.md)) offers to
resume from the recovery snapshot if one exists, or use `/session resume <id>` once a snapshot
exists.
