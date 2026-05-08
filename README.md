# GoodVibes Ecosystem

This repository is the central index for the GoodVibes projects hosted under
[mgd34msu on GitHub](https://github.com/mgd34msu). The descriptions below are
based on the current README files in the linked repositories.

## Core Runtime And SDK

| Project | Purpose |
| --- | --- |
| [goodvibes-tui](https://github.com/mgd34msu/goodvibes-tui) | Terminal-native AI coding, operations, automation, knowledge, and integration console. It can run the GoodVibes daemon/API host and exposes runtime surfaces for channels, remote peers, web clients, automation, and companion apps. |
| [goodvibes-sdk](https://github.com/mgd34msu/goodvibes-sdk) | TypeScript SDK for building clients, daemon hosts, remote surfaces, and automation around the GoodVibes daemon. Published as `@pellux/goodvibes-sdk`. |

## Operator And Companion Surfaces

| Project | Purpose |
| --- | --- |
| [goodvibes-webui](https://github.com/mgd34msu/goodvibes-webui) | Browser operator surface for the GoodVibes daemon, built with Bun, Vite, React, TypeScript, and the public SDK browser/auth/contracts surfaces. |
| [goodvibes-apk](https://github.com/mgd34msu/goodvibes-apk) | React Native Android companion app for the GoodVibes TUI/daemon. It is a remote control-plane client for daemon connection, approvals, sessions, tasks, provider state, model changes, and companion-only remote chat. |
| [goodvibes-homeassistant](https://github.com/mgd34msu/goodvibes-homeassistant) | Custom Home Assistant integration for the GoodVibes daemon Home Assistant surface. Home Assistant supplies Assist plumbing, services, sensors, repairs, sidebar UI, and Home Graph context while the daemon owns routing, knowledge, graph storage, wiki rendering, and model/provider behavior. |

## Claude Code And Desktop Tooling

| Project | Purpose |
| --- | --- |
| [goodvibes-plugin](https://github.com/mgd34msu/goodvibes-plugin) | Claude Code plugin that adds precision tool replacements, MCP tools, specialized agents, hooks, output styles, persistent memory, and WRFC quality workflows. |
| [goodvibes-desktop](https://github.com/mgd34msu/goodvibes-desktop) | Electron desktop application that provides an enhanced interface for Claude CLI with terminal sessions, session analytics, Git/GitHub integration, hooks, MCP server management, skills, agent templates, project registry, and memory management. |

## Quick Orientation

- Start with `goodvibes-tui` if you want the main terminal product and local
  daemon/runtime.
- Use `goodvibes-sdk` when building a client, integration, daemon host, or
  automation against the daemon contract.
- Use `goodvibes-webui`, `goodvibes-apk`, or `goodvibes-homeassistant` when you
  need a browser, Android, or Home Assistant surface for the daemon.
- Use `goodvibes-plugin` and `goodvibes-desktop` for Claude Code and Claude CLI
  workflows.
