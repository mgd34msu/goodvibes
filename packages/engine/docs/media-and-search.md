# Media, multimodal, and web search

GoodVibes exposes media, voice, multimodal analysis, artifact, and web-search
features through the daemon control plane and platform modules.

Daemon embedders use the dedicated `@goodvibes-jev/engine/platform/platform/multimodal`
subpath and explicit daemon/runtime wiring. Consumer apps interact through
operator methods documented below.

## Artifacts

The artifact store persists typed blobs and file attachments for later delivery,
analysis, transformation, or knowledge ingest.

Four operator methods cover the artifact lifecycle, from upload through
metadata reads to raw content retrieval.

| Method | What it does |
| --- | --- |
| `artifacts.create` | Store a file or attachment artifact for later delivery, analysis, or knowledge ingest; accepts JSON control bodies, multipart, or raw binary as described below |
| `artifacts.list` | Return stored artifact metadata for files and attachments |
| `artifacts.get` | Return metadata for one stored artifact |
| `artifacts.content.get` | Return the raw content bytes for a stored artifact |

Artifacts are used by knowledge extraction, multimodal writeback, media
providers, session export, and channel delivery.
The scoped browser knowledge platform also exposes `platformClient.artifacts.create(...)`,
`platformClient.artifacts.get(...)`, and `platformClient.artifacts.list()` so browser WebUI clients
can attach uploaded artifacts to companion-chat messages without importing the
full operator contract.

`POST /api/artifacts` supports three body families:

- JSON control bodies for small inline `text`/`dataBase64` payloads, daemon-local
  `path` references, or remote `uri` fetches.
- `multipart/form-data` with a `file` field plus optional text fields
  described in the table below.
- Raw binary bodies for large uploads. Use the request `Content-Type` as the
  artifact MIME type and pass metadata through query parameters, for example
  `?filename=manual.pdf&metadata=%7B%22source%22%3A%22homeassistant%22%7D`.

The optional multipart text fields each carry one piece of artifact metadata.

| Field | What it sets |
| --- | --- |
| `filename` | The stored artifact's file name |
| `mimeType` | The artifact MIME type, overriding the uploaded part's own type |
| `kind` | The artifact kind classification used by downstream consumers |
| `sourceUri` | Where the content originally came from, kept as provenance |
| `retentionMs` | How long the artifact lives before expiry sweeps remove it |
| `metadata` | Arbitrary JSON object attached to the artifact record |

A field that cannot be read is refused with a 400 that names it: invalid JSON in
`metadata` (multipart field or raw-upload query parameter) or a `retentionMs` that
is not a number. The artifact record has no tags and an upload fetches no URI, so
`POST /api/artifacts` ignores `tags` and `allowPrivateHosts`. `POST
/api/knowledge/ingest/artifact` accepts an upload with `title`, `folderPath`,
`tags`, `sessionId`, `sourceType`, `connectorId` and `metadata` and attaches them
to the ingested source; any other field is ignored.

`GET /api/artifacts/{id}/content` (admin only, like the artifact list) always sends
`X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`. Images
(PNG, JPEG, GIF, WebP, AVIF, BMP), audio, video, plain text and JSON are shown inline
when `?download=0` is passed; every other type (HTML, SVG, XML, scripts, PDF) is
served as `application/octet-stream` with `Content-Disposition: attachment`. An id
that does not exist answers 404; a failure reading a known artifact (an I/O error, a
size or checksum mismatch) answers 500.

Small JSON control bodies are intended for inline text, daemon-local paths, and
remote URI references. PDFs, photos, website snapshots, and other large
artifacts should use multipart or raw binary uploads so the daemon can
stream/spool the payload outside the JSON parser. Raw binary is the most
memory-stable option for very large payloads; multipart is available for browser
panels and form-based clients.

Artifact storage defaults to `storage.artifacts.maxBytes = 536870912`
(`512 MiB`). Hosts can raise that setting up to the schema limit when they have
disk and memory budget for larger ingestion workflows. Local file paths and
remote URI fetches are also streamed into the artifact store and enforce the
same artifact cap.

## Media providers

Every media provider declares which of five normalized capabilities it
implements, and each media operator method selects a provider by the
capability it needs.

| Capability | What a provider with it can do |
| --- | --- |
| `understand` | Analyze an image and return structured findings; serves `media.analyze` |
| `transform` | Convert or edit media content; serves `media.transform` |
| `generate` | Produce new media from a prompt; serves `media.generate` |
| `metadata` | Read or derive artifact metadata without full analysis |
| `attachment-store` | Hold attachment content on behalf of the runtime |

Built-in media registration wires OpenAI, Gemini, Anthropic, local image
understanding, built-in image understanding, and generation providers into a
single registry.

The built-in image understanding provider, which answers a request that names
no provider, reads an image with the session's current model only. When that
model does not accept images it refuses with `MEDIA_MODEL_CANNOT_READ_IMAGES`
and names the models that do; the image is not sent to another vendor. Name a
model (`modelId`) or a scoped provider to use another one.

Each generation provider states what it makes: BytePlus, Runway and Alibaba
make video; fal and Comfy make images and video. A lookup for one kind of
output considers only providers that make it, and a provider refuses a request
for a kind it does not make (`MEDIA_OUTPUT_UNSUPPORTED`) before anything is
sent. The model asked for is the model used, and a reference image or video
given by URL or as an artifact chooses the matching endpoint. Finished outputs
are streamed into the artifact store. A job the provider accepted but had not
finished when the wait ended (`options.waitSeconds`, ten minutes by default;
brief poll failures such as a 429 or 5xx are retried) comes back with
`pending: { providerId, taskId, resume }`; passing that task to the registry's
`collect` finishes it later without submitting, or paying for, a new job.

| Method | What it does |
| --- | --- |
| `media.providers.list` | Return registered media provider capabilities |
| `media.analyze` | Analyze an artifact through a registered media provider |
| `media.transform` | Transform an artifact through a registered media provider |
| `media.generate` | Generate a media artifact through a registered media provider |

## Multimodal service

The multimodal service provides a higher-level interface over image, audio,
video, and document analysis. It can build token-efficient packets from
analysis results and persist analysis back into artifacts and knowledge.

| Method | What it does |
| --- | --- |
| `multimodal.status` | Return the unified multimodal runtime status across image, audio, video, and document analysis |
| `multimodal.providers.list` | Return the normalized multimodal provider catalog spanning media understanding, speech-to-text, and extractors |
| `multimodal.analyze` | Analyze an image, audio file, video artifact, or document through the unified service |
| `multimodal.packet` | Build a token-efficient packet from an existing analysis result |
| `multimodal.writeback` | Persist an analysis result as an artifact and ingest it into the structured knowledge store |

## Voice providers

Each voice provider declares which of five capabilities it implements, and
the voice routes pick providers by the capability a request needs.

| Capability | What a provider with it can do |
| --- | --- |
| `tts` | Synthesize complete audio from text |
| `tts-stream` | Synthesize audio as streamed bytes for low-latency spoken output |
| `stt` | Transcribe an audio artifact to text |
| `realtime` | Open a bidirectional realtime voice session |
| `voice-list` | Enumerate the voices the provider offers |

Built-in providers:

- OpenAI
- Deepgram
- Google
- ElevenLabs
- Microsoft
- Vydra
- `local` (fully offline speech-to-text and text-to-speech; see [Local voice engines](./voice-local.md))

| Method | What it does |
| --- | --- |
| `voice.status` | Return configured voice provider posture and capabilities |
| `voice.providers.list` | Return registered voice providers |
| `voice.voices.list` | Return registered voices for a voice provider |
| `voice.tts` | Synthesize audio through a registered voice provider |
| `voice.tts.stream` | Synthesize audio as streamed bytes through a streaming provider |
| `voice.stt` | Transcribe an audio artifact through a registered voice provider |
| `voice.realtime.session` | Open a realtime voice session through a registered voice provider |

See [Voice and streaming TTS](./voice.md) for the spoken-output contract.

## Web search

The web-search service normalizes provider-backed search into ranked results
with optional evidence fetching and safe-search posture.

Built-in providers:

- DuckDuckGo
- SearxNG
- Brave
- Exa
- Firecrawl
- Tavily
- Perplexity

| Method | What it does |
| --- | --- |
| `web_search.providers.list` | Return registered web search provider capabilities |
| `web_search.query` | Execute a provider-backed web search and return normalized ranked results |

The `web_search` tool exposes search to agents when a `WebSearchService` is
registered with the tool runtime.
