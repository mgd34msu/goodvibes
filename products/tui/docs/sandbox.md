# Sandbox

## Per-command exec sandbox

On Linux, with `sandbox.enabled` true (the default where the host probe passes), shell commands the `exec` tool runs inside a bubblewrap (`bwrap`) boundary. The workspace stays writable, the rest of the filesystem is read-only, `/tmp` is isolated, and network access is off by default. Where bubblewrap is not present, or on a non-Linux host, the exec path is unchanged and the sandbox reports itself unavailable rather than claiming a boundary it cannot deliver.

A command runs without asking you as contained only when you would otherwise be asked about nothing but where it could reach (in `ask-me`, for example, a command that might send secrets out): the boundary answers that, and the decision records that the sandbox settled it, not you. A call that goes to you for any other reason (it deletes something that cannot be brought back, loosens a security setting, or is on the list only you decide) is always asked, or held for you in `just-vibes`, contained or not.

Whether the host can provide the boundary is checked once when the program starts, and the `exec` tool and the approval decision both use that one reading, so a command is never auto-approved as contained and then run on the host; installing bubblewrap takes effect after a restart. Whether the sandbox is wired at all is decided when a session starts, so turning `sandbox.enabled` on mid-session applies to the next session. Once it is wired, `sandbox.enabled`, `sandbox.workspaceWritable` and `sandbox.egressAllowlist` are read for every command, so a change applies to the next command; turning `sandbox.enabled` off mid-session makes later commands run on the host, and the approval decision follows, asking you instead of auto-approving. A `cmd_base64` command is judged by the text it decodes to, exactly as `exec` runs it. An `exec` request that carries `file_ops`, a command entry `exec` would refuse (`cmd_base64` that is not base64, or `cmd` and `cmd_base64` that disagree), or a working directory other than the session's is always shown to you, never auto-approved by the sandbox.

Two list settings adjust the boundary:

| Key | Holds | Notes |
| --- | --- | --- |
| `sandbox.workspaceWritable` | Absolute paths | Extra paths the sandboxed command may write. A relative path is refused when you set it. |
| `sandbox.egressAllowlist` | Command names | A command line gets network access back, as a named, visible escalation, only when every command in it is listed; everything else runs fully offline. You are asked about that network once, when the command runs, and the answer applies to that run only. A `working_dir` outside the session's project root is refused for a sandboxed command. |

`sandbox.judgment` (`off`, `annotate`, `auto-approve`) controls whether a model-judgment reading annotates, or with explicit opt-in settles, the ask raised when a sandboxed command needs host access. It never auto-denies.

Review the current state with `/security sandbox` and the live sessions with `/security sandbox-sessions`.

## REPL and MCP isolation

The `repl` tool is registered only where the exec sandbox is available, and each evaluation is one fresh command through the exec path (`bun -e` for JavaScript, TypeScript and SQL, `python3 -I -c` for Python), so it runs inside the same boundary as any command. A GraphQL evaluation only parses and validates, in process; nothing is executed.

`sandbox.mcpIsolation` decides how stdio MCP servers start. `disabled` (the default) runs each as a host process. `contained` runs each inside its own bubblewrap boundary: the workspace and `sandbox.workspaceWritable` paths writable, system files and the server's own install (the directory its executable lives in, and any absolute path in its arguments) read-only, `$HOME` and `/tmp` private, its own process namespace, and the host network shared, since most servers call out. On a host without bubblewrap a contained server is not started, and `/mcp` shows why. A change applies when a server next connects (`/mcp reload`). `/security contain-mcp` and `/security host-mcp` set it.

`/security start-sandbox <command|mcp-server>` opens a session whose commands (`/security run-in-sandbox`) start inside the same boundary, with the network off for `command`.

On native Windows there is no boundary; run GoodVibes inside WSL 2 with bubblewrap installed to contain commands and MCP servers.

The QEMU backend was retired, and with it the settings that chose a VM: on load, `sandbox.qemu*`, `sandbox.vmBackend`, `sandbox.replIsolation` and `sandbox.windowsMode` are removed from a settings file, and a VM `sandbox.mcpIsolation` mode (`shared-vm`, `hybrid`, `per-server-vm`) becomes `contained`, with one receipt. The `/sandbox qemu` family answers that it has been retired.
