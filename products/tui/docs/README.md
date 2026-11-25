# Documentation

This directory contains the current product documentation for `goodvibes-tui`.

## Guides

- [Getting started](getting-started.md)
  Installation, first-run setup, provider configuration and common paths.

- [Configuration reference](configuration.md)
  The layered settings model, a curated key-settings table, permission modes and the policy/trust system, plus the TUI-owned namespaces you add by hand to settings.json, covering the checkpoint root guard, the scriptable statusline, session behavior, notification alert classes, and launch-time self-update.

- [Deployment and services](deployment-and-services.md)
  TUI-only mode, adopting or autostarting the daemon, the in-process HTTP listener, inbound TLS, outbound trust configuration, control-plane entrypoints, the service registry and secret references, profiles and setup transfer, and integration helpers.

- [Remote access: a home server setup](remote-access.md)
  Step-by-step continuity setup covering the daemon on an always-on box, webui from any browser, TUI over SSH, Tailscale for reachability and TLS, and validation with `goodvibes doctor`.

- [Providers and routing](providers-and-routing.md)
  Native providers, compatible/gateway providers, local discovery, synthetic failover, search providers, voice providers, and media providers.

- [Voice and live TTS](voice-and-live-tts.md)
  Live spoken answers (System place, This session and Voice), TTS provider/voice configuration, local player requirements, and streaming voice API behavior.

- [Cloudflare batch and control plane](cloudflare-batch.md)
  Optional Workers/Queues batch setup, bootstrap-token flow, daemon routes, setup form fields, and the Cloudflare tab of Devices and network.

- [Home Assistant surface](homeassistant-surface.md)
  Home Assistant companion setup, daemon callbacks, webhook security, and setup and settings fields.

- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
  Session memory, durable memory, structured knowledge, connectors, extractors, embeddings, artifacts, and multimodal analysis.

- [Project planning](project-planning.md)
  TUI-owned conversational planning loop, passive platform planning artifacts, project-scoped knowledge spaces, readiness evaluation, and the Planning modal.

- [Channels, remote runtime, and API](channels-remote-and-api.md)
  Omnichannel surfaces, reply routing, remote peers, node-host contracts, and the daemon/control-plane HTTP + streaming surfaces.

- [Session durability](session-durability.md)
  The saved session written after every turn, and the crash snapshot written when a prompt is accepted and after tool batches (at most once every five seconds).

- [Share command](share-command.md)
  saving this conversation as a file and uploading it for a link: session export to HTML/JSON/Markdown with redaction, a Gist link, clipboard, and open options.

- [CLI flags](cli-flags.md)
  Global flags reference covering session lifecycle (`--continue`, `--resume`, `--fork`), the `-y`/`--non-interactive` commit gate for plugin bundle installs, output format consolidation, the `--host` alias, and all other startup and command-specific flags.

- [Commands reference](commands-reference.md)
  The generated, categorized list of every slash command, its arguments, and its description. It is the same list `?` renders in the product.

- [Windows support](../../../docs/windows.md)
  Running GoodVibes on Windows through WSL2; native Windows binaries are not provided.

- [Screen readers and accessibility](accessibility.md)
  What works with a screen reader, the plain headless route, and the switches for no colour, answers painted once, ASCII lines and light or dark.

- [Tools and commands](tools-and-commands.md)
  Built-in tool families and a per-tool reference, slash-command families, the full keyboard-binding reference, the agent/archetype and hook systems, MCP and plugin extensibility, and the operator, diagnostics, and workflow surfaces that tie them together.

- [Sandbox](sandbox.md)
  The per-command exec sandbox, its writable-path and egress lists, REPL evaluations running through it, and `sandbox.mcpIsolation` (MCP servers as host processes, or each inside its own bubblewrap boundary).

- [Changelog](../CHANGELOG.md)
  The terminal app's release history, including the releases before the suite (0.18 to 0.24). Suite releases are in the [release notes](../../../docs/releases/).

- [GitHub Action](github-action.md)
  The `run-goodvibes` composite action, which installs a pinned, checksum-verified release in CI and runs a non-interactive command or prompt against a workspace.
