# Session durability

GoodVibes TUI keeps two copies of a conversation on disk: the saved session and, while a turn
runs, a crash snapshot.

## Saved session

After every completed assistant turn (`TURN_COMPLETED`), `persistConversation` writes the whole
conversation through `SessionManager` (one temp file, one rename). This is the copy `/session
resume`, `--continue`, `--resume` and the session browser read. The first line of the file carries
the session's title, model and message count, so listing sessions reads one line per file.

## Crash snapshot

The crash snapshot (`writeRecoveryFile`) is written:

- when a prompt is accepted (`TURN_SUBMITTED`), so the message survives a kill during the stream;
- after each batch of tool calls (`TOOLS_DONE`), so a kill mid-turn keeps the tool work done so far;
- when the save at the end of a turn fails, so that turn is not lost;
- for a change made outside a turn (`/undo`, `/title`, a branch switch), at most once a minute and
  only when the conversation changed since the last write (`src/runtime/recovery-autosave.ts`).

The turn-time writes live in `src/core/turn-event-wiring.ts` and follow the rule both terminal apps
share (`writeCrashSnapshotAtTurnMoments`). An idle session writes nothing; the one-minute tick
then only refreshes the liveness marker that records this session as open in this terminal.

On the next start the TUI offers the newest snapshot that is not older than its session's own
saved file, unless the liveness marker shows that session is still open in another terminal, in
which case the snapshot is that terminal's live state and is not offered.

A kill at any moment loses at most the streaming text of the turn in flight and any tool calls of
that turn that had not finished. A completed turn is never lost.

Journals written by earlier versions (`transcript-<sessionId>.journal`) are still replayed once
when their session is resumed; nothing writes new ones.

## Side branches left out of a restore

A saved side branch (made with `/branch`) that this version cannot read is left out of a resume or
crash restore, and the transcript names it and the reason. The rest of the session is restored;
the next save of that session is written without the branch.

### `--continue` with no last-session pointer

If a session was killed before the first snapshot was written (i.e., no last-session pointer
exists), `--continue` and a bare `--resume` print "No previous conversation to continue. This is
a new one; /session list shows saved ones." in the transcript and then start as a plain launch
would: onboarding for a new user, or the setup wizard where a returning user left it. **Recovery path:** the startup recovery
modal (see "The startup recovery modal" in [getting-started.md](getting-started.md)) offers to
resume from the recovery snapshot if one exists, or use `/session resume <id>` once a snapshot
exists.
