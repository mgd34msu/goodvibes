# Getting started

`goodvibes` is the GoodVibes terminal app for working in a project. This guide
covers installing it, configuring a model provider and the first run.

## Install

The GoodVibes TUI is part of the GoodVibes suite. Install released binaries with
the [release installer](../../../docs/installation.md)
(`curl -fsSL https://goodvibes.sh/install.sh | sh`, Linux or macOS, no build tools
needed), or build and install from a checkout with
`scripts/install-from-checkout.sh` (Linux x64/arm64 with glibc, supplies Bun and
Node when needed, and requires a TypeSafe key for Jev). Run either as your normal
user. Both install the TUI with the daemon, Agent and WebUI; npm installs do not
install this workspace.

The checkout installer pairs the local TUI with the daemon and registers a project
workspace; after the release installer the TUI and the daemon on this machine need no pairing. For a daemon on another machine, pair from the TUI in Devices and network (Ctrl+G, m opens the menu): Pair something, This program with its daemon, with the sign-in code your own screen shows (see
[host pairing](host-pairing.md)). Launch `goodvibes` from that directory, then configure a conversation provider below.
Jev credentials and conversation-provider credentials serve different purposes.
Use `goodvibes --version` and `goodvibes-daemon --version` to inspect the installed
products. Updates and data-preserving uninstall use the installer you installed with.

A missing `rust-analyzer` or `gopls`
is never installed behind your back: a code lookup says which server is missing
and how to install it, and "install a language server" (Code and changes, Code
intelligence) installs it into your GoodVibes bin directory when you ask.

## First run

When the model a session would use is not ready, `goodvibes` opens first run,
which is three steps and the same in the Agent:

1. Choose how to get a model, from what is already set up on this computer:
   keys found in the environment, model servers found on this computer, or
   another provider.
2. Sign in, or paste a key. A key the provider refuses is not kept.
3. Start: the conversation opens with one sentence saying when GoodVibes asks
   before acting.

Then type a question about the project, for example `What does this project do,
and how do I run its tests?`, and press Enter: it reads the files it needs and
answers. When a key in your environment already makes a provider usable, first
run uses it and you start here.

Leaving part way and starting again resumes from where you were: a provider
chosen but not signed in opens step 2. After first run the splash names the
model in use. Everything else is set up later on the Setup tab of the System
place (the menu, `Ctrl+G` then `m`), which lists topics and opens one form per
topic.

## Configure a model provider

API keys resolve from environment variables first, then from the GoodVibes
secret store. The local store can hold encrypted values directly, or a stored
key can be a reference that resolves through one of eight source kinds at
lookup time:

| Source | Where the value comes from |
| --- | --- |
| `env` | An environment variable, read at resolution time |
| `goodvibes` | The encrypted local secret store itself |
| `file` | A file on disk whose contents are the secret |
| `exec` | A command whose output is the secret |
| `1password` | A 1Password vault item, through the `op` CLI |
| `bitwarden` | A Bitwarden item, through the `bw` CLI |
| `vaultwarden` | A self-hosted Vaultwarden server, through the same `bw` CLI with a `server` parameter |
| `bitwarden-secrets-manager` | Bitwarden Secrets Manager (`bws`), addressed by secret id |

The fastest path is an environment variable:

```sh
export OPENAI_API_KEY=...
```

| Provider | Primary Env Var | Accepted Aliases | Type |
|----------|----------------|-----------------|------|
| Anthropic | `ANTHROPIC_API_KEY` | `CLAUDE_API_KEY` | Paid |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_KEY` | Paid |
| Google Gemini | `GEMINI_API_KEY` | `GOOGLE_API_KEY`, `GOOGLE_GEMINI_API_KEY` | Paid |
| InceptionLabs | `INCEPTION_API_KEY` | none | Paid |
| Mistral | `MISTRAL_API_KEY` | none | Paid |
| OpenRouter | `OPENROUTER_API_KEY` | none | Free tier available |
| Groq | `GROQ_API_KEY` | none | Free (LPU inference) |
| Cerebras | `CEREBRAS_API_KEY` | none | Free (wafer-scale inference) |
| AIHubMix | `AIHUBMIX_API_KEY` | none | Free tier (rate-limited) |
| HuggingFace | `HF_API_KEY` | `HUGGINGFACE_API_KEY`, `HF_TOKEN` | Free tier (rate-limited) |
| Ollama Cloud | `OLLAMA_CLOUD_API_KEY` | `OLLAMA_API_KEY` | Free |
| NVIDIA NIM | `NVIDIA_API_KEY` | none | 1000 free credits |
| LLM7 | `LLM7_API_KEY` | none | Free |

Additional built-in integrations resolve from the same env/secrets path. The cloud-platform and subscription providers use their platforms' own credential variables, and the voice, search, and media providers each take an API key:

| Integration | Variables |
| --- | --- |
| AWS Bedrock | `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` |
| Anthropic on Vertex AI | `GOOGLE_APPLICATION_CREDENTIALS`, `ANTHROPIC_VERTEX_PROJECT_ID` or `GOOGLE_CLOUD_PROJECT` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |
| Every compatible/gateway provider | Its API key variable, listed per provider in [providers-and-routing.md](providers-and-routing.md) (for example `DEEPSEEK_API_KEY`, `TOGETHER_API_KEY`, `XAI_API_KEY`) |
| Perplexity search | `PERPLEXITY_API_KEY` |
| Deepgram voice | `DEEPGRAM_API_KEY` |
| ElevenLabs voice | `ELEVENLABS_API_KEY` or `XI_API_KEY` |
| Vydra voice | `VYDRA_API_KEY` |
| BytePlus media | `BYTEPLUS_API_KEY` |
| Fal media | `FAL_KEY` or `FAL_API_KEY` |
| Comfy media | `COMFY_API_KEY` (optional, for cloud ComfyUI) |
| Runway media | `RUNWAYML_API_SECRET` or `RUNWAY_API_KEY` |

Alternatively, store keys encrypted: in the app, "Store a secret" on the
Secrets tab of Permissions and safety (the menu, `Ctrl+G` then `m`) asks for
the value on a hidden line. From a shell, `goodvibes secrets set OPENAI_API_KEY --user`
does the same: it asks for the value without showing it, or reads it from
standard input when piped, so the key never lands in your shell history.

For self-hosted or external secret managers, link a GoodVibes key to a
provider-backed secret reference ("Point a secret at a password manager" on
the same tab, or from a shell):

```sh
goodvibes secrets link OPENAI_API_KEY 'goodvibes://secrets/bitwarden?item=GoodVibes%20OpenAI&field=password' --user
goodvibes secrets link SLACK_BOT_TOKEN 'goodvibes://secrets/vaultwarden?item=GoodVibes%20Slack&field=password&server=https%3A%2F%2Fvault.example.test' --user
goodvibes secrets link STRIPE_TOKEN 'goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000?field=value' --user
goodvibes secrets link OPENAI_API_KEY 'goodvibes://secrets/1password?vault=Private&item=GoodVibes%20OpenAI&field=API%20Key' --user
```

`goodvibes secrets providers` lists the supported provider shapes and `goodvibes secrets test <secret-ref>` validates a ref without printing its value (the same as "See where secrets can come from" and "Test a secret reference" on the Secrets tab).

Environment variables take precedence over stored secrets when both are present.

## Tool access and completion

`goodvibes --yolo` runs one launch in the `yolo` execution mode, including
access outside the project for read/search/map tools, and `goodvibes
--just-vibes` runs one launch without interrupting you, holding anything that
needs you for the end. Both are shorthand for `--config permissions.mode=...`
and neither persists. Authentication, scopes and other deterministic checks
remain in force. See [CLI flags](cli-flags.md#--yolo).

Composer input and `--prompt` reach the conversation model directly. The answer
streams as it is written and stands as soon as it ends; it is not held for a
check. Only an answer that followed work the turn delegated (agents or a
contract) gets one [reading of its claims](../../../packages/engine/docs/runtime-orchestration.md#completion-verification)
afterwards: when the decision model finds that it says work was done that the
agents or the contract did not do or finish, one line says so; when it finds
nothing, or cannot answer, nothing is said.

## Launch and resume

Opening the TUI in a workspace starts a fresh session. Previous work is reached
only deliberately. `--continue` reopens the most recently active session for the
working directory, `--resume [id]` reopens a named one, and `--fork [id]`
branches from one. See [CLI session lifecycle flags](tools-and-commands.md#cli-session-lifecycle-flags).
After the splash, a short notice summarizes the resumable state that actually
exists on disk (saved sessions, workspace checkpoints, chain history) and names
the command that reaches each one.

### The startup recovery offer

If a session crashed before saving, its crash snapshot survives on disk. At the
next launch one line says so, the same in the terminal app and the Agent, and
nothing opens over the composer:

`[Recovery] "<title>" stopped before it was saved: Ctrl+R restores it, Esc discards it, typing starts a new one.`

It is drawn under the splash, where you are looking, and kept in System, Notices.

Nothing loads unless you press Ctrl+R; the recovery point is retired once the
load succeeds, and a failed load leaves the file in place to be offered again at
the next start. Esc on an empty composer deletes it. Typing anything starts a new
conversation: the offer closes quietly for this run and the snapshot is offered
again at the next start. A session opened later (`--continue`, `--resume`, the
Sessions place) with a snapshot newer than its saved copy gets the same line. A
snapshot whose session another running terminal has open is never offered,
because it is that instance's live state rather than an orphaned crash.

## Common paths

Project runtime data lives under `.goodvibes/` in the working directory. The
release installer keeps global data in `~/.goodvibes` unless `GOODVIBES_HOME` is
set. The checkout installer sets `GOODVIBES_HOME` to
`~/.local/share/goodvibes-data`, so global paths shown as `~/.goodvibes`
below resolve under that directory instead; a custom `--data-dir` relocates it.
The specific files worth knowing:

| Path | What it holds |
| --- | --- |
| `~/.goodvibes/tui/settings.json` | Global settings |
| `.goodvibes/tui/settings.json` | Project settings overriding the global layer |
| `~/.goodvibes/tui/secrets.enc` or `.goodvibes/tui/secrets.enc` | Encrypted secrets, global or per project |
| `~/.goodvibes/goodvibes.secrets.json` | Compatibility secrets read by older suite components |
| `~/.goodvibes/tui/services.json` | The service registry (a project's file adds only services naming keys in your store) |
| `~/.goodvibes/daemon` | The daemon's own home and state directory |
| `~/.goodvibes/tui/providers/*.json` | Custom provider definitions, hot-reloaded |
| `.goodvibes/tui/automation-jobs.json` | Scheduled and automation jobs |
| `.goodvibes/tui/repl-history.json` | REPL history |
| `~/.goodvibes/tui/keybindings.json` | Keybinding overrides |
| `.goodvibes/agents/*.md` | Agent archetypes |
| `.goodvibes/mcp.json` | MCP server config |
| `hooks.json` (project root) | Hook config (or the file named by `tools.hooksFile`, resolved against the project directory) |

## First things to open in the product

The menu (the leader key `Ctrl+G`, then `m`) reaches every place; a few typed commands remain for the conversation itself:

| Command or place | What it opens |
| --- | --- |
| `/help` (also `?` and `Ctrl+P`) | The commands that remain, every key, and the menu |
| `/model` | Your model and the others you can use, switching, and backup models |
| `/settings` | The settings screen; every setting is shown by a plain name with its key beside it |
| System, Setup (the menu) | Setting GoodVibes up, one topic at a time |
| Memory and knowledge (the menu) | What the project remembers, your knowledge, what is known about you, your templates |
| Tools and extensions (the menu) | Your hooks and which ran, the model's tools, tool servers, plugins, the curated marketplace and skills |
| Work and agents (the menu): Runners | Remote runners the daemon starts and keeps, if you use them |
| Tools and extensions, Servers (the menu) | Add, edit, remove, reload, and inspect MCP servers while the TUI is running |

## Local server discovery

In Models and providers (the menu: `Ctrl+G`, then `m`), `m` ("Find model servers on this computer") has the daemon discover local inference servers and register them as OpenAI-compatible providers for every program; a running program takes them at once. Your local network is scanned from Devices and network. Discovery does not run automatically at startup; the scan probes well-known ports and, where a fixed port is not enough, the server's own response headers. Built-in discovery covers:

| Server | Identified by |
| --- | --- |
| Ollama | Port 11434 |
| LM Studio | Port 1234, or its fingerprint in headers or model ids |
| vLLM | `x-vllm-*` response headers |
| llama.cpp | `llama` in the `server` response header |
| LocalAI | `localai` in the `server` response header |
| Text Generation Inference (TGI) | `text-generation-inference` in response headers |
| Jan | Port 1337 |
| GPT4All | Port 4891 |
| KoboldCpp | Port 5001 |
| Aphrodite | Port 2242 |

Which servers get a dedicated adapter versus the generic OpenAI-compatible one is covered in [providers-and-routing.md](providers-and-routing.md).

## Related docs

- [Deployment and services](deployment-and-services.md)
- [Providers and routing](providers-and-routing.md)
- [Tools and commands](tools-and-commands.md)
