/**
 * The environment variables GoodVibes reads, with what each does, for the
 * `env` section of docs/llms-full.txt (generate-llms-full.ts).
 *
 * No registry in the code lists them, so this file does, and the generator
 * keeps it honest: it scans the sources below for every variable the programs
 * and the installer read, and fails while one of them is neither described
 * here nor covered by a registry (the provider key catalog and the credential
 * scope registry, whose variables it describes itself). A described variable
 * nothing reads fails too.
 */

/** Where the scan looks, and the name each tree is reported under. */
export const ENV_SCAN_ROOTS: readonly { readonly path: string; readonly product: string }[] = [
  { path: 'packages/engine/platform/src', product: 'every program' },
  { path: 'packages/engine/terminal-shell/src', product: 'terminal apps' },
  { path: 'packages/engine/daemon-api/src', product: 'goodvibes-daemon' },
  { path: 'packages/engine/transport-core/src', product: 'every program' },
  { path: 'packages/engine/transport-http/src', product: 'every program' },
  { path: 'packages/engine/transport-realtime/src', product: 'every program' },
  { path: 'packages/engine/operator-client/src', product: 'every program' },
  { path: 'packages/engine/peer-client/src', product: 'every program' },
  { path: 'packages/engine/errors/src', product: 'every program' },
  { path: 'packages/judgment/src', product: 'every program' },
  { path: 'products/tui/src', product: 'goodvibes' },
  { path: 'products/tui/bin', product: 'goodvibes' },
  { path: 'products/agent/src', product: 'goodvibes-agent' },
  { path: 'products/agent/bin', product: 'goodvibes-agent' },
  { path: 'products/daemon/src', product: 'goodvibes-daemon' },
  { path: 'products/daemon/bin', product: 'goodvibes-daemon' },
  { path: 'scripts/install.ts', product: 'installer' },
  { path: 'scripts/installation.ts', product: 'installer' },
  { path: 'scripts/uninstall.ts', product: 'installer' },
];

/** Shell scripts whose `${NAME...}` reads count, except for names the script assigns itself. */
export const ENV_SCAN_SHELL_FILES: readonly string[] = ['scripts/install.sh', 'scripts/install-from-checkout.sh', 'scripts/uninstall.sh'];

/** Names the scan finds that the programs do not read from their own environment, with why. */
export const ENV_SCAN_IGNORED: Readonly<Record<string, string>> = {
  GIT_OBJECT_DIRECTORY: 'set for a child git process, never read',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: 'set for a child git process, never read',
  PORT: 'text of a project template the tools check, not read by GoodVibes',
  DOCKER_HOST: 'set for a child docker process from a remote runner\'s settings, never read',
  CF_BOOTSTRAP: 'the example variable name in /cloudflare\'s create-token action; the command reads whichever variable the owner names, never this one',
  BITWARDENCLI_APPDATA_DIR: 'set for the Bitwarden CLI from storage.secretProviders settings, never read',
};

export interface EnvEntry {
  readonly name: string;
  /** Which programs read it, in words. */
  readonly readBy: string;
  /** What setting it changes and what happens, in plain sentences. */
  readonly does: string;
  /** The setting it stands in for, and how (`used when the setting is empty`). */
  readonly setting?: { readonly key: string; readonly relation: string } | undefined;
  /** Set by GoodVibes for its own child processes or service; a person does not set it. */
  readonly internal?: true | undefined;
  /** Read through a name the scan cannot see (a variable built at run time); kept without a scan hit. */
  readonly readIndirectly?: true | undefined;
}

export const ENV_CATALOG: readonly EnvEntry[] = [
  // GoodVibes locations and identity
  { name: 'GOODVIBES_HOME', readBy: 'goodvibes, goodvibes-agent, goodvibes-daemon', does: 'The directory the GoodVibes tree is put under in place of the login home, for the terminal app, the Agent and the daemon: everything under `~/.goodvibes/` moves to `$GOODVIBES_HOME/.goodvibes/` (each app\'s and the daemon\'s settings, the shared file, local users and device tokens, stores, the voice tree, the secret stores and `secrets.key`), and the daemon home with it unless `GOODVIBES_DAEMON_HOME` is set. A relative value is taken from the current directory; an empty value counts as unset. The checkout installer sets it to its data directory in each command wrapper. `GOODVIBES_AGENT_HOME`, when set, moves the Agent alone instead.' },
  { name: 'GOODVIBES_DAEMON_HOME', readBy: 'goodvibes, goodvibes-agent, goodvibes-daemon', does: 'The daemon home, otherwise `<tree>/.goodvibes/daemon`: the daemon settings file `settings.json`, the daemon secret store (`secrets.enc`), `operator-tokens.json`, `owner-profile.md` and `daemon-settings.json`. For the daemon itself it is also the tree root when `GOODVIBES_HOME` is not set, so local users (`auth-users.json`, `auth-bootstrap.txt`), device tokens, memory, the owner inbox and its other stores move to `<dir>/.goodvibes/` and the daemon shares nothing with another one. The terminal app and Agent read only the daemon\'s files (operator token, daemon settings) from it. `goodvibes-daemon --daemon-home <dir>` does the same for one command and wins over the variable.' },
  { name: 'GOODVIBES_AGENT_HOME', readBy: 'goodvibes-agent', does: 'The directory Agent puts its tree under in place of `GOODVIBES_HOME` (else the login home), moving the Agent alone: everything Agent keeps under `.goodvibes/` (its settings, sessions, memory, skills, personas, routines, the shared file, its secret stores and `secrets.key`) moves to `$GOODVIBES_AGENT_HOME/.goodvibes/`, and so does the daemon file it reads unless `GOODVIBES_DAEMON_HOME` is set.' },
  { name: 'GOODVIBES_WORKING_DIR', readBy: 'goodvibes, goodvibes-agent, goodvibes-daemon', does: 'The working directory (project) a program starts in, in place of the current directory. For the daemon, `--working-dir` wins over it and it wins over the saved `runtime.workingDir`.' },
  { name: 'HOME', readBy: 'every program, installer', does: 'The login home. The GoodVibes tree is `$HOME/.goodvibes` unless `GOODVIBES_HOME` moves it; the installers put commands in `$HOME/.local/bin` by default.' },
  { name: 'USERPROFILE', readBy: 'terminal apps', does: 'On Windows, the home directory used to shorten a saved file\'s path to `~` in a message when `HOME` is not set.' },
  { name: 'APPDATA', readBy: 'every program', does: 'On Windows, where the Google Cloud CLI keeps its credentials (`%APPDATA%\\gcloud`) when `CLOUDSDK_CONFIG` is not set; read for the `anthropic-vertex` provider.' },
  { name: 'USER', readBy: 'goodvibes-daemon', does: 'The account name `loginctl enable-linger` is run for when the daemon service is installed on Linux, so it starts at boot rather than at login.' },
  { name: 'LOGNAME', readBy: 'goodvibes-daemon', does: 'The account name used for `loginctl enable-linger` when `USER` is not set.' },
  { name: 'PATH', readBy: 'every program, installer', does: 'Where programs are looked up: the daemon program for the service, `git`, `bwrap`, editors, password-manager CLIs and every command the model runs. The installers check whether the command directory is on it and print the line to add when it is not.' },
  { name: 'PATHEXT', readBy: 'goodvibes', does: 'On Windows, the executable extensions tried when looking for the daemon program on `PATH`.' },
  { name: 'TMPDIR', readBy: 'installer', does: 'Where the installers make their temporary working directory; `/tmp` when unset.' },
  { name: 'XDG_STATE_HOME', readBy: 'installer', does: 'Where the release installer keeps its receipt of the programs it installed (`$XDG_STATE_HOME/goodvibes/installed-programs`, else `~/.local/state/goodvibes/installed-programs`), one absolute path per line. A copy of a program that shadows the installed one on `PATH` is removed only when this receipt lists it.' },
  { name: 'SHELL', readBy: 'installer', does: 'The login shell, which decides the shell start-up file the release installer adds its `PATH` line to (and removes it from on uninstall).' },

  // Talking to the daemon
  { name: 'GOODVIBES_DAEMON_TOKEN', readBy: 'goodvibes, goodvibes-agent, goodvibes-daemon', does: 'An operator token. When set and not blank, every daemon call the program makes uses it as the bearer token, ahead of any stored token or login session. A daemon started with it set also accepts it as its operator token.' },
  { name: 'GOODVIBES_HTTP_TOKEN', readBy: 'goodvibes-daemon', does: 'The bearer token the daemon\'s HTTP listener (`danger.httpListener`) requires. When unset the listener uses `GOODVIBES_DAEMON_TOKEN`, then the daemon\'s own token.' },
  { name: 'GOODVIBES_CONNECTED_HOST_TOKEN', readBy: 'goodvibes-agent', does: 'The token Agent sends to the daemon it is connected to, ahead of `GOODVIBES_DAEMON_TOKEN` and the stored pairing.' },
  { name: 'GOODVIBES_AGENT_RUNTIME_URL', readBy: 'goodvibes-agent', does: 'The address of the daemon Agent connects to (for example `http://127.0.0.1:3421`). `--runtime-url` does the same for one launch.' },
  { name: 'GOODVIBES_AGENT_BASE_URL', readBy: 'goodvibes-agent', does: 'An older name for `GOODVIBES_AGENT_RUNTIME_URL`, read only when that is not set.' },
  { name: 'GOODVIBES_DAEMON_BINARY', readBy: 'goodvibes, goodvibes-agent', does: 'The daemon program a terminal app writes into the service definition it installs, in place of the one it finds next to itself or on `PATH`.' },
  { name: 'GOODVIBES_DAEMON_COMMAND', readBy: 'goodvibes', does: 'The daemon program the terminal app starts or reports in `service` and `status`, in place of the packaged one.' },
  { name: 'GOODVIBES_TAILNET_ADDRESSES', readBy: 'every program', does: 'Addresses in the 100.64.0.0/10 range (comma or space separated, or the whole range `100.64.0.0/10`) to treat as Tailscale addresses, so plain `http://` to them is allowed like any private-network address.' },
  { name: 'GOODVIBES_ALLOW_INSECURE_TRANSPORT', readBy: 'every program, web UI', does: '`true` or `1` allows a plain `http://` or `ws://` daemon address on a public host. Without it such an address is refused; private-network addresses never need it.' },
  { name: 'NO_PROXY', readBy: 'every program', does: 'Hosts that bypass the proxy set in `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` (either spelling; `no_proxy` too). While a proxy is set, every program adds `localhost`, `127.0.0.1`, `[::1]`, `::1` and any other loopback host it dials to both spellings, keeping the owner\'s entries, so a request to this machine (the daemon, a local model server) never goes through the proxy; child processes inherit the list. A `*` entry already bypasses every host and is left as it is.' },

  // Behaviour switches
  { name: 'GOODVIBES_AGENT_DEBUG', readBy: 'goodvibes-agent', does: '`1` or `true` prints the stack trace when Agent fails during start-up.' },
  { name: 'GOODVIBES_COST_BUDGET_USD', readBy: 'goodvibes', does: 'A spending alert amount in US dollars written to `behavior.budgetAlertUsd` at start, only when that setting has never been stored. A stored value (including `0`, alert off) is kept.' },
  { name: 'GOODVIBES_AUTH_PASSWORD', readBy: 'goodvibes', does: 'The password `goodvibes auth add-user` and `goodvibes auth rotate-password` use when neither `--password` nor `--password-stdin` is given.' },
  { name: 'GOODVIBES_CHAT_LIMITER_THRESHOLD', readBy: 'goodvibes-daemon', does: 'Companion chat messages allowed per session per minute, read once at daemon start; 10 when unset.', setting: { key: 'runtime.companionChatLimiter.perSessionLimit', relation: 'a positive setting wins over the variable' } },
  { name: 'GOODVIBES_JUDGMENT_MONITOR', readBy: 'every program', does: 'A path to a JSON file of decision call-volume budgets, used when `judgment.volumeMonitor` is not enabled.', setting: { key: 'judgment.volumeMonitor', relation: 'the setting, when enabled, wins' } },
  { name: 'GOODVIBES_POLICY_SIGNING_KEY', readBy: 'every program', does: 'The key (hexadecimal, at least 16 bytes) policy bundles must be signed with when `policy.requireSignedBundles` is on. With that setting on and no key, every bundle is refused.', setting: { key: 'policy.requireSignedBundles', relation: 'the key the setting checks against' } },
  { name: 'GOODVIBES_PUSH_ALLOW_LOCAL_ENDPOINTS', readBy: 'goodvibes-daemon', does: '`1` lets a web push subscription name a plain-http, loopback or private-network endpoint (a development push relay). Off by default.' },
  { name: 'GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD', readBy: 'goodvibes-daemon', does: 'When set, the daemon does not download the wake-word model files at install or start. The outcome message says how to fetch them later.' },
  { name: 'GOODVIBES_SUPPRESS_NOTIFY', readBy: 'every program', does: '`1` or `true` stops desktop notifications and notification webhooks from being sent.' },
  { name: 'GOODVIBES_PLAYWRIGHT_CORE', readBy: 'every program', does: 'A directory holding the browser driver (`playwright-core`), searched before the copies shipped beside the program.' },
  { name: 'PLAYWRIGHT_BROWSERS_PATH', readBy: 'every program', does: 'Where browsers for the browser tools are kept and installed; by default `~/.cache/ms-playwright` (Linux), `~/Library/Caches/ms-playwright` (macOS).' },
  { name: 'NODE_ENV', readBy: 'every program', does: '`test` stops desktop notifications and notification webhooks. The daemon service definition passes the value on (`production` when unset).' },
  { name: 'NO_COLOR', readBy: 'terminal apps', does: 'Any non-empty value turns colour off.' },
  { name: 'TERM', readBy: 'terminal apps', does: 'The terminal type. `dumb` turns colour and line-drawing characters off; known values turn 24-bit colour on.' },
  { name: 'COLORTERM', readBy: 'terminal apps', does: '`truecolor` or `24bit` says the terminal draws 24-bit colour.' },
  { name: 'TERM_PROGRAM', readBy: 'terminal apps', does: 'The terminal program; known names turn 24-bit colour on.' },
  { name: 'LANG', readBy: 'terminal apps', does: 'The locale, read after `LC_ALL` and `LC_CTYPE`: a non-UTF-8 locale (`C`, `POSIX`) makes the work tree draw with plain ASCII.' },
  { name: 'LC_ALL', readBy: 'terminal apps', does: 'The locale, read first; see `LANG`.' },
  { name: 'LC_CTYPE', readBy: 'terminal apps', does: 'The locale, read after `LC_ALL`; see `LANG`.' },
  { name: 'COLUMNS', readBy: 'goodvibes-agent', does: 'The terminal width when the terminal does not report one.' },
  { name: 'LINES', readBy: 'goodvibes-agent', does: 'The terminal height when the terminal does not report one.' },
  { name: 'VISUAL', readBy: 'terminal apps', does: 'The editor the apps open for editing a prompt or a file; read before `EDITOR`.' },
  { name: 'EDITOR', readBy: 'terminal apps', does: 'The editor the apps open when `VISUAL` is not set.' },
  { name: 'DISPLAY', readBy: 'every program', does: 'An X display; with `WAYLAND_DISPLAY` it decides whether a graphical browser or image viewer can be opened, and which clipboard command is used.' },
  { name: 'WAYLAND_DISPLAY', readBy: 'every program', does: 'A Wayland display; see `DISPLAY`. Its presence selects the Wayland clipboard command.' },
  { name: 'WSL_DISTRO_NAME', readBy: 'every program', does: 'Present inside WSL: links and images open in Windows, and the sandbox is treated as running under WSL.' },
  { name: 'WSL_INTEROP', readBy: 'every program', does: 'Present inside WSL; read with `WSL_DISTRO_NAME` to detect WSL.' },
  { name: 'HERMES_HOME', readBy: 'goodvibes-agent', does: 'A directory whose `SOUL.md` Agent adds to its project context files.' },
  { name: 'VIRTUAL_ENV', readBy: 'every program', does: 'An active Python virtual environment; a new worktree\'s setup commands run inside it.' },
  { name: 'GIT_DIR', readBy: 'every program', does: 'Git\'s own variable. When set, GoodVibes treats the directory as inside a repository and keeps it set for the git commands it runs in that repository.' },
  { name: 'CUDA_VISIBLE_DEVICES', readBy: 'goodvibes-agent', does: 'When set, Agent\'s local-model readiness report says a GPU is available.' },
  { name: 'NVIDIA_VISIBLE_DEVICES', readBy: 'goodvibes-agent', does: 'Read like `CUDA_VISIBLE_DEVICES`.' },
  { name: 'SUDO_PASSWORD', readBy: 'goodvibes-agent', does: 'Only checked for presence: Agent\'s setup report says whether it is set. GoodVibes never sends it anywhere.' },
  { name: 'ACP_AGENT_CMD', readBy: 'every program', does: 'The command a helper agent is started with over the Agent Client Protocol: a JSON array of program and arguments (`["/path/to/agent", "acp"]`), a path to an existing file, or a command line split on spaces. Unset uses the running program\'s own `acp` command.' },
  { name: 'HERDR_ENV', readBy: 'terminal apps', does: 'Set by the herdr terminal multiplexer; with `HERDR_PANE_ID`, `HERDR_BIN_PATH` and `HERDR_SOCKET_PATH` it makes the apps report their session state to the pane.' },
  { name: 'HERDR_PANE_ID', readBy: 'terminal apps', does: 'The herdr pane the app runs in; see `HERDR_ENV`.' },
  { name: 'HERDR_BIN_PATH', readBy: 'terminal apps', does: 'The herdr program; see `HERDR_ENV`.' },
  { name: 'HERDR_SOCKET_PATH', readBy: 'terminal apps', does: 'The herdr socket; see `HERDR_ENV`.' },

  // Decision model
  { name: 'TYPESAFE_BASE_URL', readBy: 'every program', does: 'The decision model\'s address when `judgment.endpoint` is empty; the hosted Jev address when both are empty.', setting: { key: 'judgment.endpoint', relation: 'used when the setting is empty' } },
  { name: 'TYPESAFE_DEFAULT_MODEL', readBy: 'every program', does: 'The decision model name when `judgment.model` is empty; `jev-latest` when both are empty.', setting: { key: 'judgment.model', relation: 'used when the setting is empty' } },

  // Providers and services: addresses, regions and options (keys are listed from the provider catalog)
  { name: 'OPENAI_BASE_URL', readBy: 'every program', does: 'The OpenAI API address for OpenAI voice and for memory embeddings.' },
  { name: 'OPENAI_API_BASE', readBy: 'every program', does: 'Read like `OPENAI_BASE_URL` when that is not set.' },
  { name: 'OPENAI_EMBEDDING_MODEL', readBy: 'every program', does: 'The OpenAI embedding model used for memory search.' },
  { name: 'GEMINI_BASE_URL', readBy: 'every program', does: 'The Gemini API address used for memory embeddings.' },
  { name: 'GOOGLE_GEMINI_BASE_URL', readBy: 'every program', does: 'Read like `GEMINI_BASE_URL` when that is not set.' },
  { name: 'GEMINI_EMBEDDING_MODEL', readBy: 'every program', does: 'The Gemini embedding model used for memory search.' },
  { name: 'GEMINI_API_BASE_URL', readBy: 'every program', does: 'The Gemini API address for Google voice.' },
  { name: 'GOOGLE_API_BASE_URL', readBy: 'every program', does: 'Read like `GEMINI_API_BASE_URL` when that is not set.' },
  { name: 'MISTRAL_BASE_URL', readBy: 'every program', does: 'The Mistral API address used for memory embeddings.' },
  { name: 'MISTRAL_EMBEDDING_MODEL', readBy: 'every program', does: 'The Mistral embedding model used for memory search.' },
  { name: 'OLLAMA_BASE_URL', readBy: 'every program', does: 'The Ollama server used for memory embeddings.' },
  { name: 'OLLAMA_HOST', readBy: 'every program', does: 'Read like `OLLAMA_BASE_URL` when that is not set.' },
  { name: 'OLLAMA_EMBEDDING_MODEL', readBy: 'every program', does: 'The Ollama embedding model used for memory search.' },
  { name: 'LM_STUDIO_API_KEY', readBy: 'every program', does: 'The key sent to an LM Studio server that requires one, for chat and memory embeddings.' },
  { name: 'LM_STUDIO_BASE_URL', readBy: 'every program', does: 'The OpenAI-compatible server (LM Studio or similar) used for memory embeddings; `http://127.0.0.1:1234/v1` when neither it nor `OPENAI_COMPATIBLE_BASE_URL` is set.' },
  { name: 'OPENAI_COMPATIBLE_BASE_URL', readBy: 'every program', does: 'Read like `LM_STUDIO_BASE_URL` when that is not set.' },
  { name: 'OPENAI_COMPAT_BASE_URL', readBy: 'every program', does: 'Read like `OPENAI_COMPATIBLE_BASE_URL` when that is not set.' },
  { name: 'LM_STUDIO_EMBEDDING_MODEL', readBy: 'every program', does: 'The embedding model on the OpenAI-compatible server used for memory search.' },
  { name: 'OPENAI_COMPATIBLE_EMBEDDING_MODEL', readBy: 'every program', does: 'Read like `LM_STUDIO_EMBEDDING_MODEL` when that is not set.' },
  { name: 'OPENAI_COMPAT_EMBEDDING_MODEL', readBy: 'every program', does: 'Read like `OPENAI_COMPATIBLE_EMBEDDING_MODEL` when that is not set.' },
  { name: 'AZURE_OPENAI_ENDPOINT', readBy: 'every program', does: 'The resource address (`https://<resource>.openai.azure.com`) the `microsoft-foundry` provider sends to. Without it or `AZURE_FOUNDRY_ENDPOINT` that provider sends nothing.' },
  { name: 'AZURE_FOUNDRY_ENDPOINT', readBy: 'every program', does: 'Read like `AZURE_OPENAI_ENDPOINT` when that is not set.' },
  { name: 'OPENAI_COMPATIBLE_API_KEY', readBy: 'every program', does: 'Read like `LM_STUDIO_API_KEY` when that is not set.' },
  { name: 'OPENAI_COMPAT_API_KEY', readBy: 'every program', does: 'Read like `OPENAI_COMPATIBLE_API_KEY` when that is not set.' },
  { name: 'DEEPGRAM_BASE_URL', readBy: 'every program', does: 'The Deepgram API address for speech to text.' },
  { name: 'DEEPGRAM_API_BASE', readBy: 'every program', does: 'Read like `DEEPGRAM_BASE_URL` when that is not set.' },
  { name: 'ELEVENLABS_BASE_URL', readBy: 'every program', does: 'The ElevenLabs API address for voice.' },
  { name: 'XI_API_BASE', readBy: 'every program', does: 'Read like `ELEVENLABS_BASE_URL` when that is not set.' },
  { name: 'VYDRA_BASE_URL', readBy: 'every program', does: 'The Vydra API address for voice.' },
  { name: 'COMFY_BASE_URL', readBy: 'every program', does: 'The ComfyUI server image generation sends to; `http://127.0.0.1:8188` when unset. The Comfy key is sent only to this server or Comfy Cloud.' },
  { name: 'COMFY_WORKFLOW_DIR', readBy: 'every program', does: 'A directory, besides the working directory, a ComfyUI workflow file may be read from.' },
  { name: 'AWS_REGION', readBy: 'every program', does: 'The AWS region for the Amazon Bedrock providers; `us-east-1` when neither this nor `AWS_DEFAULT_REGION` is set.' },
  { name: 'AWS_DEFAULT_REGION', readBy: 'every program', does: 'Read like `AWS_REGION` when that is not set.' },
  { name: 'AWS_SESSION_TOKEN', readBy: 'every program', does: 'The session token sent with an AWS access-key pair to Amazon Bedrock.' },
  { name: 'ANTHROPIC_VERTEX_BASE_URL', readBy: 'every program', does: 'The Vertex AI address for the `anthropic-vertex` provider, in place of the one built from the region.' },
  { name: 'ANTHROPIC_VERTEX_USE_GCP_METADATA', readBy: 'every program', does: '`1` lets the `anthropic-vertex` provider authenticate with the Google Cloud metadata server (on a Google Cloud machine).' },
  { name: 'CLOUD_ML_REGION', readBy: 'every program', does: 'The Vertex AI region for `anthropic-vertex`; read after `GOOGLE_CLOUD_LOCATION`; `global` when neither is set.' },
  { name: 'GOOGLE_CLOUD_LOCATION', readBy: 'every program', does: 'The Vertex AI region for `anthropic-vertex`, read first.' },
  { name: 'CLOUDSDK_CONFIG', readBy: 'every program', does: 'The Google Cloud CLI configuration directory, where `anthropic-vertex` looks for the credentials `gcloud auth application-default login` wrote.' },
  { name: 'BRAVE_SEARCH_API_KEY', readBy: 'every program', does: 'The Brave Search key for web search; read before a `brave-search` service entry.' },
  { name: 'BRAVE_API_KEY', readBy: 'every program', does: 'Read like `BRAVE_SEARCH_API_KEY` when that is not set.' },
  { name: 'EXA_API_KEY', readBy: 'every program', does: 'The Exa key for web search; read before an `exa` service entry.' },
  { name: 'FIRECRAWL_API_KEY', readBy: 'every program', does: 'The Firecrawl key for web search; read before a `firecrawl` service entry.' },
  { name: 'TAVILY_API_KEY', readBy: 'every program', does: 'The Tavily key for web search; read before a `tavily` service entry.' },
  { name: 'SEARXNG_BASE_URL', readBy: 'every program', does: 'The SearXNG instance web search uses; required for the SearXNG backend unless a `searxng` service entry gives `baseUrl`.' },
  { name: 'BW_SESSION', readBy: 'every program', does: 'The unlocked Bitwarden session passed to the Bitwarden CLI when a `bitwarden` or `vaultwarden` secret reference is read and `storage.secretProviders.bitwarden.sessionEnv` names no other variable.' },
  { name: 'BWS_ACCESS_TOKEN', readBy: 'every program', does: 'The Bitwarden Secrets Manager access token passed to the `bws` CLI when no other variable is named in its setting.' },
  { name: 'GITHUB_TOKEN', readBy: 'goodvibes', does: 'The GitHub token `/share` uses to upload a session as a gist when no `github` service entry is stored.' },
  { name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', readBy: 'every program', does: 'The OpenTelemetry collector address traces are exported to.' },
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', readBy: 'every program', does: 'The collector base address; traces go to `<value>/v1/traces` when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is not set.' },
  { name: 'OTEL_EXPORTER_OTLP_TRACES_HEADERS', readBy: 'every program', does: 'Request headers for the trace collector, as `key=value,key=value` with URL-encoded values.' },
  { name: 'OTEL_EXPORTER_OTLP_HEADERS', readBy: 'every program', does: 'Read like `OTEL_EXPORTER_OTLP_TRACES_HEADERS` when that is not set.' },

  // Channels: addresses and ids (credentials are listed from the credential registry)
  { name: 'SLACK_CLIENT_ID', readBy: 'goodvibes-daemon', does: 'The Slack app\'s OAuth client id for building the Slack install link, when the request gives none.' },
  { name: 'SLACK_CLIENT_SECRET', readBy: 'goodvibes-daemon', does: 'The Slack app\'s OAuth client secret for finishing the Slack install, when the request gives none.' },
  { name: 'DISCORD_APPLICATION_ID', readBy: 'goodvibes-daemon', does: 'The Discord application id for the bot invite link, when neither the request nor `surfaces.discord.applicationId` gives one.' },
  { name: 'MSTEAMS_APP_ID', readBy: 'goodvibes-daemon', does: 'The Microsoft Teams bot app id, when `surfaces.msteams.appId` is empty.' },
  { name: 'MSTEAMS_TENANT_ID', readBy: 'goodvibes-daemon', does: 'The Microsoft Teams tenant id for sending.' },
  { name: 'MSTEAMS_SERVICE_URL', readBy: 'goodvibes-daemon', does: 'The Microsoft Teams service address for sending.' },
  { name: 'MSTEAMS_WEBHOOK_SECRET', readBy: 'goodvibes-daemon', does: 'The secret incoming Microsoft Teams requests are checked against.' },
  { name: 'MATRIX_WEBHOOK_SECRET', readBy: 'goodvibes-daemon', does: 'The secret incoming Matrix webhook requests are checked against, when `surfaces.matrix.webhookSecret` and the stored Matrix signing secret are not set. With none of the three, the Matrix access token is used.', setting: { key: 'surfaces.matrix.webhookSecret', relation: 'used when the setting is empty' } },
  { name: 'MATTERMOST_WEBHOOK_SECRET', readBy: 'goodvibes-daemon', does: 'The secret incoming Mattermost webhook requests are checked against, when `surfaces.mattermost.webhookSecret` and the stored Mattermost signing secret are not set. With none of the three, the Mattermost bot token is used.', setting: { key: 'surfaces.mattermost.webhookSecret', relation: 'used when the setting is empty' } },
  { name: 'MATTERMOST_BASE_URL', readBy: 'goodvibes-daemon', does: 'The Mattermost server address for sending.' },
  { name: 'MATRIX_HOMESERVER', readBy: 'goodvibes-daemon', does: 'The Matrix homeserver address for sending.' },
  { name: 'SIGNAL_BRIDGE_URL', readBy: 'goodvibes-daemon', does: 'The Signal bridge address for sending.' },
  { name: 'IMESSAGE_BRIDGE_URL', readBy: 'goodvibes-daemon', does: 'The iMessage bridge address for sending.' },
  { name: 'BLUEBUBBLES_SERVER_URL', readBy: 'goodvibes-daemon', does: 'The BlueBubbles server address for sending iMessage through BlueBubbles.' },
  { name: 'WHATSAPP_BRIDGE_URL', readBy: 'goodvibes-daemon', does: 'A WhatsApp bridge address, used when `surfaces.whatsapp.bridgeUrl` and the `whatsapp` service entry give none.' },
  { name: 'WHATSAPP_BASE_URL', readBy: 'goodvibes-daemon', does: 'The WhatsApp Cloud API address; `https://graph.facebook.com/v17.0` when unset.' },
  { name: 'TELEPHONY_BRIDGE_URL', readBy: 'goodvibes-daemon', does: 'The telephony bridge address for calls and texts.' },
  { name: 'TWILIO_FROM_NUMBER', readBy: 'goodvibes-daemon', does: 'The number texts and calls are sent from, when `surfaces.telephony.fromNumber` is empty.' },
  { name: 'TELEPHONY_FROM_NUMBER', readBy: 'goodvibes-daemon', does: 'Read like `TWILIO_FROM_NUMBER` when that is not set.' },
  { name: 'HOMEASSISTANT_URL', readBy: 'goodvibes-daemon', does: 'The Home Assistant address, when the Home Assistant settings give none.' },
  { name: 'HOME_ASSISTANT_URL', readBy: 'goodvibes-daemon', does: 'Read like `HOMEASSISTANT_URL` when that is not set.' },
  { name: 'HA_URL', readBy: 'goodvibes-daemon', does: 'Read like `HOME_ASSISTANT_URL` when that is not set.' },
  { name: 'GITHUB_WEBHOOK_SECRET', readBy: 'goodvibes-daemon', does: 'The secret GitHub automation webhooks are checked against; without it they are refused.' },

  // Relay server
  { name: 'GOODVIBES_RELAY_PORT', readBy: 'relay server', does: 'The port the stand-alone relay server listens on; 8787 when unset.' },
  { name: 'GOODVIBES_RELAY_HOST', readBy: 'relay server', does: 'The address the stand-alone relay server listens on.' },

  // Cloudflare Worker bindings
  { name: 'GOODVIBES_DAEMON_URL', readBy: 'Cloudflare Worker', does: 'The daemon address the Worker forwards to; must be `https://` unless `GOODVIBES_ALLOW_INSECURE_DAEMON_URL` is `true`. GoodVibes sets it when it deploys the Worker.' },
  { name: 'GOODVIBES_ALLOW_INSECURE_DAEMON_URL', readBy: 'Cloudflare Worker', does: '`true` lets `GOODVIBES_DAEMON_URL` be plain `http://`.' },
  { name: 'GOODVIBES_ALLOW_PRIVATE_DAEMON_URL', readBy: 'Cloudflare Worker', does: '`true` lets `GOODVIBES_DAEMON_URL` name a private, loopback or link-local host (a tunnel or private deployment).' },
  { name: 'GOODVIBES_WORKER_TOKEN', readBy: 'Cloudflare Worker', does: 'The token callers of the Worker must present; without it the Worker refuses them.' },
  { name: 'GOODVIBES_OPERATOR_TOKEN', readBy: 'Cloudflare Worker', does: 'The operator token the Worker sends to the daemon, when `GOODVIBES_OPERATOR_TOKEN_STORE` holds none.' },
  { name: 'GOODVIBES_OPERATOR_TOKEN_STORE', readBy: 'Cloudflare Worker', does: 'A Cloudflare Secrets Store binding holding the operator token, read first. GoodVibes binds it when it deploys the Worker with a secrets store.' },
  { name: 'GOODVIBES_ACCESS_CLIENT_ID', readBy: 'Cloudflare Worker', does: 'A Cloudflare Access service-token client id the Worker sends to the daemon.' },
  { name: 'GOODVIBES_ACCESS_CLIENT_SECRET', readBy: 'Cloudflare Worker', does: 'The Cloudflare Access service-token secret, when `GOODVIBES_ACCESS_CLIENT_SECRET_STORE` holds none.' },
  { name: 'GOODVIBES_ACCESS_CLIENT_SECRET_STORE', readBy: 'Cloudflare Worker', does: 'A Cloudflare Secrets Store binding holding the Access client secret, read first.' },
  { name: 'GOODVIBES_QUEUE_JOB_PAYLOADS', readBy: 'Cloudflare Worker', does: '`true` lets the Worker put batch job payloads on its queue instead of refusing them. GoodVibes sets it when it deploys the Worker.' },
  { name: 'GOODVIBES_BATCH_QUEUE', readBy: 'Cloudflare Worker', does: 'The Cloudflare Queue binding batch jobs go on. GoodVibes binds it when it deploys the Worker with a queue.' },
  { name: 'GOODVIBES_KV', readBy: 'Cloudflare Worker', does: 'The Cloudflare KV binding job records are kept in.' },
  { name: 'GOODVIBES_ARTIFACTS', readBy: 'Cloudflare Worker', does: 'The Cloudflare R2 bucket binding large job payloads are kept in.' },
  { name: 'GOODVIBES_COORDINATOR', readBy: 'Cloudflare Worker', does: 'The Durable Object binding that counts queue use against the daily limits.' },
  { name: 'GOODVIBES_FREE_TIER_MODE', readBy: 'Cloudflare Worker', does: '`true` holds queue use to the daily limits below. GoodVibes sets it when it deploys the Worker.' },
  { name: 'GOODVIBES_MAX_QUEUE_OPS_PER_DAY', readBy: 'Cloudflare Worker', does: 'Queue operations allowed per day in free-tier mode.' },
  { name: 'GOODVIBES_MAX_QUEUE_MESSAGES_PER_DAY', readBy: 'Cloudflare Worker', does: 'Queue messages allowed per day in free-tier mode.' },
  { name: 'GOODVIBES_MAX_QUEUE_PAYLOAD_BYTES', readBy: 'Cloudflare Worker', does: 'The largest job payload, in bytes, the Worker puts on its queue.' },

  // Installer
  { name: 'GOODVIBES_VERSION', readBy: 'installer', does: 'The release `install.sh` installs, such as `v3.3.3`; `latest` when unset. The uninstaller without a receipt fetches that release\'s script.' },
  { name: 'GOODVIBES_DAEMON_VERSION', readBy: 'installer', does: 'The daemon release to install, when it should differ from `GOODVIBES_VERSION`.' },
  { name: 'GOODVIBES_AGENT_VERSION', readBy: 'installer', does: 'The Agent release to install, when it should differ from `GOODVIBES_VERSION`.' },
  { name: 'GOODVIBES_WEBUI_VERSION', readBy: 'installer', does: 'The web UI release to install, when it should differ from `GOODVIBES_VERSION`.' },
  { name: 'GOODVIBES_INSTALL_DIR', readBy: 'installer', does: 'Where `install.sh` puts the commands; `~/.local/bin` when unset. `--bin-dir` does the same.' },
  { name: 'GOODVIBES_AGENT', readBy: 'installer', does: '`0` skips installing Agent.' },
  { name: 'GOODVIBES_WEBUI', readBy: 'installer', does: '`0` skips installing the web UI.' },
  { name: 'GOODVIBES_WAKE_MODEL', readBy: 'installer', does: '`0` skips downloading the wake-word model.' },
  { name: 'GOODVIBES_DAEMON_SERVICE', readBy: 'installer', does: '`0` skips installing the daemon as a service and records `service.enabled` false, so a daemon started by hand never installs one. `--no-service` does the same.' },
  { name: 'GOODVIBES_RESTART_DAEMON', readBy: 'installer', does: '`0` leaves running daemons and Agents on their previous program until they are restarted by hand. A program attached to a terminal is never restarted by the installer.' },
  { name: 'GOODVIBES_AUTO_UPDATE', readBy: 'installer', does: '`0` writes `update.auto` and `update.autoUpdateAtLaunch` false in the daemon\'s settings before any program starts, so the daemon, the terminal app and the Agent never update themselves. `--no-auto-update` does the same.' },
  { name: 'GOODVIBES_RELEASE_DIR', readBy: 'installer', does: 'A directory holding a release\'s files and its `SHA256SUMS.txt`: the installer copies every file from it, checks each against that list as it checks a download, and makes no request to GitHub. `--from-dir DIR` does the same.' },
  { name: 'GOODVIBES_SHADOW_REMOVE', readBy: 'installer', does: 'What to do with an older GoodVibes command found earlier on `PATH`: `ask` (default, asks on a terminal), `1` (remove recognised copies), `0` (only report).' },
  { name: 'GOODVIBES_UNINSTALL', readBy: 'installer', does: '`1` makes `install.sh` remove the installed programs and services instead of installing; user data is kept. `--uninstall` does the same.' },
  { name: 'GOODVIBES_INSTALL_SH_LIB', readBy: 'installer', does: '`1` loads `install.sh` as a library of functions without running an install.', internal: true },
  { name: 'GOODVIBES_SUITE_RUNTIME', readBy: 'every program', does: 'The private Bun and Node a checkout installation ships; its command wrappers set it, and the browser tools use those runtimes before the ones on `PATH`.', internal: true },

  // Set by GoodVibes for its own processes
  { name: 'GOODVIBES_LAUNCH_UPDATED_FROM', readBy: 'goodvibes', does: 'Set on the restarted terminal app after a launch-time update, carrying the version it updated from.', internal: true },
  { name: 'GOODVIBES_AGENT_LAUNCH_UPDATED_FROM', readBy: 'goodvibes-agent', does: 'Set on the restarted Agent after a launch-time update, carrying the version it updated from.', internal: true },
  { name: 'GOODVIBES_DAEMON_NATIVE_PREFIX', readBy: 'goodvibes-daemon', does: 'The installation prefix the daemon launcher starts the native daemon from.', internal: true },
  { name: 'GOODVIBES_NATIVE_STARTUP_OBSERVATION', readBy: 'goodvibes-daemon', does: '`1` makes the daemon print each start-up phase, for the installer\'s start check.', internal: true },
  { name: 'GOODVIBES_ENGINE_TEST_RUNNER', readBy: 'every program', does: '`1` checks every emitted event against its declared fields; set by the test runner.', internal: true },
];
