# Providers and routing

## Provider model

GoodVibes has a layered provider system. Each layer registers providers in a different way, and the sections below cover them in this order:

| Layer | What it is |
| --- | --- |
| Native runtime providers | First-party adapters that speak each vendor's own API and auth scheme |
| Compatible and gateway providers | OpenAI- or Anthropic-compatible endpoints and aggregator gateways, registered through a shared adapter with a base URL and an API key |
| Synthetic failover groups | The `synthetic` provider, which groups one model across every backend that serves it and fails over between them |
| Local discovered providers | Inference servers on your machine or LAN that `/scan` finds and registers as OpenAI-compatible providers |
| Search providers | Web-search backends behind the single `web_search` tool surface |
| Voice providers | Text-to-speech, speech-to-text, and realtime audio backends used by `/tts` and voice input |
| Media and multimodal providers | Image-understanding and media-generation backends |

All of these flow into the same runtime routing, picker, metadata, and health surfaces.

### Where a provider's model list comes from

No provider keeps a list of models in the program. A provider's list is what its own endpoint answers (its models listing, for example OpenAI's `/v1/models` and, when signed in with a subscription, the plan's own list), else its last answer on disk, else the pinned model catalog's rows for it (the models.dev snapshot each release pins). A model the provider lists that the catalog does not know yet is selectable the day it ships, marked unclassified. A model you type that no list names is still sent, and the provider's refusal, if it refuses, is reported as it is.

The lists are read again in the background, never on a request's path: at start-up (a list on disk younger than a day answers without a request), after a sign-in (a subscription's list is stored per account), when the model picker opens (again answered from disk while a list is younger than a day), on `/model refresh` (always read), and when an endpoint refuses a model as unknown (at most once a minute per provider). Each read is one listing request per sign-in. `goodvibes doctor` and `goodvibes-agent status` show the provider, the sign-in order and where the list came from and how old it is.

## Native chat/runtime providers

Native providers carry their own client for a vendor's first-party API, rather than going through the shared OpenAI-compatible adapter. The current built-ins:

| Provider | What it talks to |
| --- | --- |
| `openai` | OpenAI, with two ways of signing in: a ChatGPT subscription (the Codex surface, `/provider sign-in openai`) and an OpenAI API key. One provider, one model list. Requests use the subscription when it is set up, else the API key; with both set up, a request the subscription fails is asked again of the same model through the API key, and the turn says so once |
| `anthropic` | The Anthropic Messages API with an Anthropic API key |
| `gemini` | The Google Gemini API |
| `amazon-bedrock` | AWS Bedrock, authenticated with AWS credentials; the live model list comes from Bedrock's own catalog call |
| `amazon-bedrock-mantle` | Bedrock Mantle, the Anthropic-shaped surface of the same AWS account, sharing its Bedrock control plane |
| `anthropic-vertex` | Claude models served through Google Cloud Vertex AI |
| `github-copilot` | The GitHub Copilot subscription, with a cached Copilot token exchange |

## Compatible and gateway providers

The runtime also supports a broad compatible/gateway layer. Each entry below is registered with a fixed base URL and activates when its API key is present, in the environment variable shown or in `/secrets`. The current built-ins:

| Provider | Display name | API key variable |
| --- | --- | --- |
| `inceptionlabs` | Inception Labs (Mercury models) | `INCEPTION_API_KEY` |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` |
| `aihubmix` | AiHubMix | `AIHUBMIX_API_KEY` |
| `groq` | Groq | `GROQ_API_KEY` |
| `cerebras` | Cerebras | `CEREBRAS_API_KEY` |
| `mistral` | Mistral | `MISTRAL_API_KEY` |
| `ollama-cloud` | Ollama Cloud | `OLLAMA_CLOUD_API_KEY` or `OLLAMA_API_KEY` |
| `huggingface` | HuggingFace | `HF_API_KEY`, `HUGGINGFACE_API_KEY`, `HF_TOKEN`, or `HUGGING_FACE_HUB_TOKEN` |
| `nvidia` | NVIDIA | `NVIDIA_API_KEY` or `NIM_API_KEY` |
| `llm7` | LLM7 | `LLM7_API_KEY` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` |
| `fireworks` | Fireworks | `FIREWORKS_API_KEY` |
| `microsoft-foundry` | Microsoft Foundry | `AZURE_OPENAI_API_KEY` |
| `minimax` | MiniMax (Anthropic-compatible endpoint) | `MINIMAX_API_KEY` |
| `moonshot` | Moonshot | `MOONSHOT_API_KEY` |
| `qianfan` | Qianfan | `QIANFAN_API_KEY` |
| `qwen` | Qwen | `QWEN_API_KEY`, `DASHSCOPE_API_KEY`, or `MODELSTUDIO_API_KEY` |
| `sglang` | SGLang (local server, port 30000) | `SGLANG_API_KEY` |
| `stepfun` | StepFun | `STEPFUN_API_KEY` |
| `together` | Together AI | `TOGETHER_API_KEY` |
| `venice` | Venice | `VENICE_API_KEY` |
| `volcengine` | Volcengine | `VOLCANO_ENGINE_API_KEY` |
| `xai` | xAI | `XAI_API_KEY` |
| `xiaomi` | Xiaomi MiMo | `XIAOMI_API_KEY` |
| `zai` | Z.ai | `ZAI_API_KEY` or `Z_AI_API_KEY` |
| `cloudflare-ai-gateway` | Cloudflare AI Gateway (OpenAI models through your gateway; set `cloudflare.accountId` (or `CLOUDFLARE_ACCOUNT_ID`) and `cloudflare.aiGatewayId` (or `CLOUDFLARE_AI_GATEWAY_ID`), or nothing is sent; a setting change applies at once) | `CLOUDFLARE_AI_GATEWAY_API_KEY` (the OpenAI key the gateway passes on) |
| `vercel-ai-gateway` | Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| `litellm` | LiteLLM (local gateway, port 4000) | `LITELLM_API_KEY` |
| `copilot-proxy` | Copilot Proxy (local gateway, port 3000) | `COPILOT_PROXY_API_KEY` |
| `cohere` | Cohere | `COHERE_API_KEY` or `CO_API_KEY` |
| `deepinfra` | DeepInfra | `DEEPINFRA_API_KEY` |
| `perplexity` | Perplexity chat completions, distinct from the search provider of the same name below | `PERPLEXITY_API_KEY` |
| `sambanova` | SambaNova | `SAMBANOVA_API_KEY` |
| `opencode-zen` | OpenCode Zen (opencode.ai) | `OPENCODE_ZEN_API_KEY` or `OPENCODE_API_KEY` |
| `zenmux` | ZenMux | `ZENMUX_API_KEY` |
| `zenmux-anthropic` | ZenMux (Anthropic-compatible endpoint of the same provider) | `ZENMUX_API_KEY` |

## Local discovery

Run `/scan` to probe localhost and the LAN for local inference servers and register whatever answers as OpenAI-compatible providers; discovery is not run automatically at startup. Startup restores previously discovered providers from the local cache without probing their hosts or removing unavailable servers. The scan probes each candidate's `/v1/models` endpoint and identifies the server either by its well-known port or by fingerprinting its response headers. Servers with a dedicated adapter get server-specific capability traits (tool calling, streaming, and, for Ollama, LM Studio, and llama.cpp, a four-level `instant/low/medium/high` reasoning ladder); the rest register through the generic OpenAI-compatible adapter with no server-specific reasoning support.

| Server | Identified by | Adapter |
| --- | --- | --- |
| Ollama | Port 11434 | Dedicated |
| LM Studio | Port 1234, or an `lmstudio` fingerprint in headers or model ids on any port | Dedicated |
| vLLM | `x-vllm-*` response headers on any port | Dedicated |
| llama.cpp | `llama` in the `server` response header on any port | Dedicated |
| Text Generation Inference | `text-generation-inference` in response headers | Dedicated |
| LocalAI | `localai` in the `server` response header on any port | Generic |
| Jan | Port 1337 | Generic |
| GPT4All | Port 4891 | Generic |
| KoboldCpp | Port 5001 | Generic |
| Aphrodite | Port 2242 | Generic |

Use `/provider add <name> <baseURL>` to register a server manually instead, which probes its `/models` endpoint directly rather than scanning ports.

## Synthetic failover

The `synthetic` provider groups the same model across multiple backends under a single selectable entry. It fails over between those backends on rate limits and transient errors (the exact rules are under "Transparent failover rules" below), never crosses the free, paid, and subscription boundary, shows each grouped model with its provider count in the picker, and ranks backends using benchmark data from the catalog. For free-tier synthetic models, the runtime can also cascade to the next-best free model when every backend for the current synthetic model is exhausted.

### Setting up failover

Failover needs more than one backend to fail over to, so set API keys for several free providers. A workable minimum:

```sh
export GROQ_API_KEY="..."
export HF_API_KEY="..."
export NVIDIA_API_KEY="..."
export OLLAMA_CLOUD_API_KEY="..."
export OPENROUTER_API_KEY="..."
export AIHUBMIX_API_KEY="..."
```

Then pick any model from the `synthetic` provider. Keys can equally be stored with `/secrets set <NAME> <value>`; environment variables win when both are set.

### What synthetic models are

Synthetic models are models available from multiple providers, automatically grouped by the system under a single selectable entry. When you pick a synthetic model, the system routes your request to the best available backend. You never need to think about which provider is serving it.

Models with different naming across providers (for example `GPT-4o` vs `gpt 4o`) are automatically merged into one entry. Each synthetic model shows how many providers are available for failover in the model picker.

### Transparent failover rules

Within a single synthetic model, backends are tried in order (best context window first, then best max output tokens as a tiebreaker), skipping any backend whose provider is not configured (a key in the environment or stored with `/secrets` both count). Each backend gets one attempt; this layer does the retrying. A failed backend is marked on a cooldown and the next backend in the list is tried immediately, in the same call, with no wait:

- **Rate limit (429) or an out-of-credit/billing error.** The failed backend is put on cooldown (the provider's own retry-after when it sends one, otherwise 60 seconds by default) and the next backend is tried right away.
- **Other 4xx errors from the provider (401, 403, 404, and similar).** Treated as provider-specific rather than the caller's fault: the backend gets a 60-second cooldown and the next backend is tried.
- **Server error (500) or network error.** Treated as transient: the backend gets a short five-second cooldown and the next backend is tried immediately, without waiting out that cooldown first.
- **Client error (400).** Does not trigger failover. A 400 means the request itself is malformed, not the provider, so switching providers would not help.
- **All backends cooling down, shortest remaining cooldown 120 seconds or less.** The turn waits out that cooldown and makes one retry attempt on the backend that just came off it. Longer cooldowns are not waited out; the error surfaces immediately instead.

The model name in the status bar does not change when the runtime switches backends for the same synthetic model, but every rotation and every cooldown wait is reported as a retry of the turn, naming the provider and the reason (for example "Every provider for kimik25 is cooling down; waiting 45 s for groq's rate limit.").

### Cross-model failover (free tier only)

When every backend for a free synthetic model is exhausted and cooldowns are too long to wait out, the system falls back to the next-best free model ranked by benchmark score, notifies inline without blocking the turn, and cascades until it finds a working free model. Free, paid, and subscription tiers never mix. This cascade only happens within the free tier.

> **Cost-accrual caveat:** this system is not perfect, and charges can accrue in ways it cannot always catch. This happens notably when a provider moves a model from free to paid while a session has been running longer than 24 hours without a model refresh, since the system has no way to know the model is now paid. Refreshes happen automatically when a session is started or resumed after the 24-hour catalog TTL expires; for long-running sessions, refresh the model list daily.

### Paid and subscription exhaustion

Paid and subscription models do not switch to a model you did not choose, because the choice of model was deliberate and cost-conscious. When every backend of a paid synthetic model is exhausted, the turn moves to your own `provider.fallbackModels` (see below); with none left, it stops and shows recovery options instead:

- wait a few minutes for the rate limit to reset and retry
- switch model with `/model`
- switch to a free model with `/model`, choosing the free tier

Any other paid or subscription model follows the rules under "Failover notices and cost delta" below: the same model on another sign-in first, then only your own `provider.fallbackModels`, else the turn stops and says why.

### Model picker grouping

Synthetic models are split into **Top Models** (S-tier or A-tier by benchmark) and **All Synthetic**. Each entry shows how many providers are available for failover, and quality tier badges (S/A/B/C) are shown next to model names based on composite benchmark score.

A provider whose endpoint did not return its model list during the startup model discovery sweep (nothing listening, credentials refused, an unreadable answer) shows `Health: unreachable: <the failure>` in the detail area when the provider, or one of its models, is selected, in both the TUI and the Agent picker. The picker reads this from the provider registry when it opens; it sends no request of its own.

### Failover notices and cost delta

Besides the backend rotation inside a single synthetic model described above, a failed model never moves to a model you did not choose:

1. The same model on another sign-in of the same provider comes first, inside the request: OpenAI asks the API key after the subscription fails. The turn says once which sign-in answered and why.
2. Only when every sign-in of the provider has failed, and the request's retries are spent, does the turn move to another model, and then only by your own fallback order, `provider.fallbackModels` (a list of provider-qualified ids, for example `["anthropic:claude-sonnet-5"]`; the provider half matches by id or display name, any case): the first entry not yet tried this turn whose provider is signed in. The engine's turn loop sends the failed request again to it, and the rest of the turn, tool calls already made included, continues there; nothing is resubmitted and no tool runs twice. The same rule runs in the TUI, `goodvibes run`, the Agent, the daemon's hosted sessions and its agents.
3. With no fallback order set, or every entry tried, the turn stops and its failure row in the transcript says so, with `alt+r try again` and `alt+o use another model`; why nothing else was tried is in the row's details (`alt+i`), and while no fallback order is set the row's tip names `/model backup`. No model is picked by list position, tier or age.

Each move adds a line naming both models, the position in your order and the error, with the cost delta when the catalog prices both models per 1M tokens, and the model that answers:

```
[Failover] openai:gpt-6.1-sol -> anthropic:claude-sonnet-5, entry 1 of your fallback order (provider.fallbackModels) (Rate limited: ...) [cost/1M: input $2.00→$3.00, output $10.00→$15.00]. claude-sonnet-5 answers the rest of this turn; the next turn starts on openai:gpt-6.1-sol again.
```

If pricing data is unavailable for either model, the line says `[cost data unavailable]` instead of fabricating a number. In the TUI a second line follows once the providers' declared setup has been read, naming the billing class the move left and joined, for example `[Failover] billing: API key → Subscription: billing class changed`; a side whose setup is not established says `Unknown`. While the move is in force the header and footer name the model answering, marked `failover from <your model>`. The model selection itself never changes, so the next turn starts on what you chose.

### Chain visibility in the model picker

When a synthetic model is selected in the model picker, the detail area below the list shows the first rung of its fallback ladder (`0. provider/model`) instead of showing a dead-end "synthetic" label. When the chain has more than one entry, the first rung is shown with a `(+N more)` suffix disclosing the remaining fallbacks. Non-synthetic models continue to show context window and capability flags.

### CLI: inspect synthetic chains

Use `goodvibes models chain` to list all synthetic model fallback ladders from the command line. It is the same data available in the TUI picker:

```sh
goodvibes models chain               # all synthetic models
goodvibes models chain balanced      # filter by model id substring
goodvibes models chain --json        # JSON output for scripting
```

Each entry shows the model id, tier, configured/total backend count, and a position-numbered list of `provider/model` rungs.

Many model providers also support configurable reasoning effort, but the levels a given model actually offers are resolved per model rather than fixed. The runtime checks the live catalog entry for that exact model first, then a declaration attached to it (a plugin, a custom-model file, or a local server's traits), then a curated per-family table, and only falls back to a labelled best guess when nothing else matches.

Depending on the model, offered levels are drawn from a fixed ladder ordered from least to most reasoning spend. For models whose only control is a thinking-token budget (Claude 4.5 and earlier, Gemini 2.5.x), each level maps to a fixed budget:

| Level | Token budget on budget-controlled models |
| --- | --- |
| `none` | 0 (offered only when the model can genuinely disable reasoning) |
| `instant` | 0 |
| `minimal` | 1024 |
| `low` | 2048 |
| `medium` | 8192 |
| `high` | 32768 |
| `xhigh` | 49152 |
| `max` | 63999 |

Models that only expose reasoning as an on/off toggle treat any level above `none` as on, at the model's own depth. Models with no configurable reasoning offer no levels at all. `/effort` shows exactly which of these the current model accepts.

## Per-role routing

`/model` opens a picker with five routing targets, each writing its own config keys, so a provider/model choice for one role never overwrites another:

| Target | Label | Config keys | Notes |
| --- | --- | --- | --- |
| `main` | Main Chat | `provider.provider` + `provider.model` | Default provider and model for normal chat turns. |
| `helper` | Helper Model | `helper.globalProvider` + `helper.globalModel` (+ `helper.enabled`) | Optional route for supporting work; empty values inherit Main Chat. |
| `tool` | Tool LLM | `tools.llmProvider` + `tools.llmModel` (+ `tools.llmEnabled`) | Optional route for tool-specific reasoning; selecting a model enables it. |
| `tts` | TTS LLM | `tts.llmProvider` + `tts.llmModel` | Optional override for `/tts` response generation; empty values use the current chat model. |
| `embeddings` | Embeddings | `provider.embeddingProvider` | Not an LLM route: an embedding provider id only, no model concept, used for memory search and the code index. |

The embeddings target has no model to pick, only a provider, so it opens a dedicated embedding-provider list instead of the model list the other four targets share.

## Custom providers

Any OpenAI-compatible API can be added by dropping JSON into:

- `~/.goodvibes/tui/providers/*.json`

For example:

```json
{
  "name": "openrouter",
  "displayName": "OpenRouter",
  "type": "openai-compat",
  "baseURL": "https://openrouter.ai/api/v1",
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "models": [
    {
      "id": "anthropic/claude-sonnet-4-6",
      "displayName": "Claude Sonnet 4.6 (via OpenRouter)",
      "description": "Anthropic Claude Sonnet 4.6 via OpenRouter",
      "contextWindow": 200000,
      "capabilities": {
        "toolCalling": true,
        "codeEditing": true,
        "reasoning": true,
        "multimodal": true
      }
    }
  ]
}
```

A model's `contextWindow` is optional. Leave it out when the endpoint does not state one: the model's window is then shown as unknown (the status line reads `context 29.9k / unknown`) and no compaction or small-model prompt is driven by a guessed number. `/provider add` writes it only when the endpoint reported a window. When a provider accepts a request larger than a model's stated window, that window is treated as disproven and shown as unknown too.

Provider JSON is hot-reloaded, so custom provider definitions appear in the model/runtime surfaces without restarting the process. Use `/provider add` for interactive guided setup.

## Daemon OpenAI-Compatible API

The daemon hosts an OpenAI-compatible surface for local clients that can speak the OpenAI REST shape but need GoodVibes provider routing:

```text
GET  /v1/models
POST /v1/chat/completions
```

Use the normal daemon base URL and bearer token. Model ids include the special id `goodvibes/current` (routes to whatever model the TUI session is currently serving), provider-qualified registry keys such as `openai:gpt-5.5`, and unambiguous plain model ids. Chat completions accept standard `messages`, optional `tools`, `max_tokens` or `max_completion_tokens`, and `stream: true` for SSE chunks.

The surface is enabled by default and gated by `controlPlane.openaiCompatible.enabled`; the path prefix is configurable via `controlPlane.openaiCompatible.pathPrefix` (default `/v1`).

This surface is a compatibility adapter over the current GoodVibes provider registry. It does not replace native TUI routing, model pickers, or provider health surfaces.

## Search providers

Web search runs behind a single `web_search` surface with normalized results, evidence shaping, verbosity controls, optional source fetches, and provider selection. Seven backends are built in; all but DuckDuckGo activate when their key or base URL is configured:

| Provider | What it is | Configured by |
| --- | --- | --- |
| `duckduckgo` | Keyless web search, available with no configuration | Nothing |
| `searxng` | A SearXNG metasearch instance you host yourself | `SEARXNG_BASE_URL` or a `searxng` service entry |
| `brave` | The Brave Search API | `BRAVE_SEARCH_API_KEY` or `BRAVE_API_KEY` |
| `exa` | The Exa search API | `EXA_API_KEY` |
| `firecrawl` | The Firecrawl search and scrape API | `FIRECRAWL_API_KEY` |
| `tavily` | The Tavily search API | `TAVILY_API_KEY` |
| `perplexity` | Perplexity's search-backed answers, distinct from the chat provider of the same name above | `PERPLEXITY_API_KEY` |

## Voice providers

Seven voice providers are built in. Each declares which directions it supports: `tts` (synthesize speech), `tts-stream` (stream synthesized audio for live playback), `stt` (transcribe speech), and `realtime` (bidirectional realtime audio). Providers marked "voice list" can also enumerate their available voices for the picker.

| Provider | Directions | Voice list |
| --- | --- | --- |
| `openai` | `tts`, `stt`, `realtime` | Yes |
| `elevenlabs` | `tts`, `tts-stream`, `stt`, `realtime` | Yes |
| `deepgram` | `stt` | No |
| `google` | `stt` | No |
| `microsoft` | `tts` | Yes |
| `vydra` | `tts` | Yes |
| `local` | `tts`, `tts-stream`, `stt` | No |

The `local` provider runs free, offline engines: whisper.cpp or faster-whisper for STT, and Piper or Kokoro for TTS. Pointing `voice.local.*` at engine and model paths you installed yourself never downloads anything; it reports `unconfigured` until all three keys for a direction (engine, binary, model path) are set. Running `/voice setup` instead performs a managed one-act install that fetches the Piper TTS engine and a default voice automatically, and the whisper STT engine and model where a bundle is hosted for your platform. See [voice-and-live-tts.md](voice-and-live-tts.md).

The TUI `/tts` command uses providers that advertise `tts-stream` for live local playback. Configure defaults through `/settings open tts`: `tts.provider` chooses the streaming provider, `tts.voice` chooses a provider voice, and `tts.llmProvider` / `tts.llmModel` optionally override the response model. `/tts` uses the active chat model by default when the TTS LLM override is empty. See [Voice and live TTS](voice-and-live-tts.md) for command usage and playback requirements.

## Media and multimodal providers

A unified multimodal runtime handles image, audio, video, and document analysis. Image understanding routes to the OpenAI, Gemini, or Anthropic vision APIs, or to a local OpenAI-compatible multimodal backend. Media generation has five built-in providers, each activating when its credentials are configured:

| Provider | What it is |
| --- | --- |
| `byteplus` | The BytePlus hosted generation API |
| `runway` | The Runway hosted generation API |
| `alibaba` | Alibaba Model Studio's generation API |
| `fal` | The fal hosted generation API |
| `comfy` | A ComfyUI server you point at via `COMFY_BASE_URL`, with your own workflow; `COMFY_API_KEY` is optional for cloud deployments |

## Related docs

- [Getting started](getting-started.md)
- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
