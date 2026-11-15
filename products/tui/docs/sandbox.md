# Sandbox

## Per-command exec sandbox

On Linux, with `sandbox.enabled` true (the default where the host probe passes), shell commands the `exec` tool runs inside a bubblewrap (`bwrap`) boundary. The workspace stays writable, the rest of the filesystem is read-only, `/tmp` is isolated, and network access is off by default. Where bubblewrap is not present, or on a non-Linux host, the exec path is unchanged and the sandbox reports itself unavailable rather than claiming a boundary it cannot deliver.

Whether the sandbox is available at all is decided when a session starts, so turning `sandbox.enabled` on mid-session applies to the next session. Once it is wired, `sandbox.enabled`, `sandbox.workspaceWritable` and `sandbox.egressAllowlist` are read for every command, so a change applies to the next command; turning `sandbox.enabled` off mid-session makes later commands run on the host, and the approval decision follows, asking you instead of auto-approving. An `exec` request that carries `cmd_base64` commands, `file_ops`, or a working directory other than the session's is always shown to you, never auto-approved by the sandbox.

Two list settings adjust the boundary:

| Key | Holds | Notes |
| --- | --- | --- |
| `sandbox.workspaceWritable` | Absolute paths | Extra paths the sandboxed command may write. A relative path is refused when you set it. |
| `sandbox.egressAllowlist` | Command names | A command line gets network access back, as a named, visible escalation, only when every command in it is listed; everything else runs fully offline. A `working_dir` outside the session's project root is refused for a sandboxed command. |

`sandbox.judgment` (`off`, `annotate`, `auto-approve`) controls whether a model-judgment reading annotates, or with explicit opt-in settles, the ask raised when a sandboxed command needs host access. It never auto-denies.

Review the current state with `/sandbox review` and the live session with `/sandbox session`.

## REPL and MCP isolation

`sandbox.vmBackend` has one value, `local`: REPL and MCP work runs on the host and is not isolated. `sandbox.replIsolation`, `sandbox.mcpIsolation` and `sandbox.windowsMode` record the preferred posture for a virtualized backend, but no backend that provides isolation ships today. The QEMU backend was retired; a settings file that still says `qemu` loads as `local` with a receipt, its `sandbox.qemu*` keys are removed, and the `/sandbox qemu` family answers that it has been retired.
