# Knowledge, artifacts, and multimodal

## Context layers

GoodVibes uses three distinct context layers. Session memory holds lightweight notes scoped to
the current session only. Durable memory is reviewed and stored in SQLite so it survives across
sessions, and it supports reuse, review, export, and injection into future tasks. A structured
knowledge store sits alongside both, holding sources, nodes, edges, issues, extractions, usage
records, consolidation candidates and reports, schedules, a GraphQL surface, and projections.

These layers work together rather than collapsing everything into transcript history.

## Durable memory

Durable memory records carry review state, a confidence score, and provenance, and they can link
to other records. They support scoped reuse across session, project, and team contexts, and move
through queue, review, and promote workflows on their way to being treated as reviewed.

Representative record classes include decisions, constraints, incidents, patterns, facts, risks,
runbooks, architecture, and ownership.

## Structured knowledge

The knowledge runtime supports ingest from several sources, including single URLs, bookmark
imports, browser-local history and bookmark profiles (only after explicit user consent), URL
lists, existing artifacts, and connector-based sources. Once content is ingested, it can be searched,
assembled into packets, linted, reindexed, and rendered or materialized as projections, and any
of that work can be saved as a schedule. The store also tracks consolidation candidates and
reports, and it answers semantic questions ("ask") with source-backed responses that return
sources, facts, linked objects, gaps, a confidence score, and whether the answer was synthesized.

The system is designed as a reviewed, self-improving knowledge store for future task context.

Regular Knowledge/Wiki and Home Assistant Home Graph are separate runtime instances. Regular knowledge routes use the default Knowledge/Wiki store. Home Graph data is accessed through `/api/homeassistant/home-graph/*` and lives in the Home Graph store. Do not use `includeAllSpaces` as a way to browse Home Graph from the regular Knowledge/Wiki surface; Home Graph has its own browse, map, pages, ask, refinement, and review routes.

## Semantic ask

The platform owns semantic question answering through:

- `POST /api/knowledge/ask`
- operator method `knowledge.ask`
- the capability `knowledge.ask` ("Ask your knowledge a question", `q` in Memory and knowledge), whose form takes the question, how long an answer, how many sources at most and a knowledge space

platform-owned semantic enrichment supports provider-backed LLM extraction with timeout, abort, and concurrency controls. Broad reindex caps LLM attempts and then continues with deterministic extraction, so hosts should wire the platform semantic service rather than implementing their own timeout or concurrency shim.

TUI rendering should display the answer object returned by the platform, every field of it:

| Field | Holds |
| --- | --- |
| `answer.text` | The answer text itself |
| `answer.sources` | The source records backing the answer |
| `answer.facts` | The facts the answer draws on |
| `answer.linkedObjects` | Knowledge objects linked from the answer |
| `answer.gaps` | Gaps the system identified while answering |
| `answer.confidence` | The confidence score |
| `answer.synthesized` | Whether the answer was synthesized rather than directly sourced |

Do not reformat search results into local answer snippets. The platform response is the answer contract; the TUI only presents it.

## Durable refinement

platform 0.28.0 adds durable semantic refinement tasks for the base knowledge layer. Refinement records preserve the gap, subject, state, trace, source assessments, blocked reasons, accepted facts, rejected evidence, and follow-up state so clients can explain what the knowledge system attempted instead of only reporting "skipped".

platform 0.28.3 coalesces overlapping semantic repair runs so repeated or concurrent refinement triggers should be bounded instead of piling up duplicate repair work. Home Graph repair-source metadata now preserves `linkedObjects` through answer rendering.

Daemon routes:

```text
GET  /api/knowledge/refinement/tasks
GET  /api/knowledge/refinement/tasks/{id}
POST /api/knowledge/refinement/run
POST /api/knowledge/refinement/tasks/{id}/cancel
```

The list route accepts filters such as `knowledgeSpaceId` or `spaceId`, `state`, `subjectKind`, `subjectId`, `gapId`, and `limit`. `POST /api/knowledge/refinement/run` is admin-gated and accepts `knowledgeSpaceId` or `spaceId`, optional `gapIds`, optional `sourceIds`, `limit`, and `force`.

Use these platform routes directly for task inspection and manual repair runs. Do not duplicate the refinement state machine in the TUI.

The daemon runtime wires platform semantic refinement to the platform web gap repairer. Gap repair uses the configured GoodVibes web search providers for source discovery and the knowledge ingest service for accepted repair sources. If web search providers are unavailable or disabled, tasks may still become blocked by search/provider readiness, but they should not report `No semantic gap repairer is configured`.

## Issue review

Knowledge issues can be reviewed in Memory and knowledge and through the daemon/operator surfaces:

- the Issues tab of Memory and knowledge: `v` on an open issue opens the review (accept, reject, resolve, reopen, accept with changes given as a JSON object, or forget), the capability `knowledge.review-issue`
- `POST /api/knowledge/issues/{id}/review`
- operator method `knowledge.issue.review`

Review actions update the issue state through the platform. `accept`, `reject`, `resolve`, and `forget` mark the issue resolved; `reopen` and `edit` return it to open. Optional JSON values can supply reviewed source or node facts for platform-owned application.

## Connectors and extractors

Connectors are the front door for ingest, covering single URLs, bookmark exports, browser-local
history and bookmark profiles, URL lists, artifacts, and future source-specific connectors as
they are added.

Built-in extractors cover HTML (including Readability-backed article extraction for suitable
pages), plain text, markdown, JSON, CSV and TSV, XML, YAML, PDF text, DOCX, XLSX, and PPTX.

## Embeddings and retrieval

The knowledge/memory runtime uses sqlite-vec with a pluggable embedding registry. Current
embedding providers include local hashed embeddings, OpenAI, OpenAI-compatible and LM Studio
endpoints, Gemini, Mistral, and Ollama. Whichever provider is configured is used for semantic
recall, knowledge packet selection, and review and search support.

### The sqlite-vec native addon

Semantic search runs on the `sqlite-vec` native extension, which the runtime
loads from `<install-dir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>` next to the
running binary. Every install channel ships it:

- **npm / Bun installs** carry it inside the platform-specific
  `@goodvibes/tui-<os>-<arch>` package and vendor it beside the binaries.
- **The pure-binary installer** (`curl -fsSL https://goodvibes.sh/install.sh | sh`)
  downloads the platform's addon as a checksum-verified release asset
  (`sqlite-vec-<os>-<arch>.<suffix>`, covered by `SHA256SUMS.txt`) and places it
  in `lib/` next to `goodvibes`, `goodvibes-daemon`, and `goodvibes-agent`. One
  copy serves all three. `/update` refreshes it in the same download-verify-swap
  pass as the binaries, so it never goes stale beside a new build.

**macOS limitation:** on macOS, `bun:sqlite` links Apple's system SQLite, which
ships with extension loading disabled. The addon is still installed for
consistency (and would work if a future runtime lifts the limit), but the
runtime reports the vector index as unavailable and memory search degrades to
literal matching. This is a permanent platform capability limit, not a
packaging defect. "Search index" (`h` on the Copies and files tab of Memory and knowledge) names the reason plainly. Linux
(including WSL2) has no such restriction.

### Copies of memory and restoring one

The memory records store (`memory.sqlite`) is copied once a day, before a
schema upgrade, and before every restore; the semantic index is not copied, it
is rebuilt from the records. The Copies and files tab of Memory and knowledge
lists the copies with their date, size and record count; `u` on one replaces
every record, link and pending consolidation proposal with those of that copy
(the capability `memory.restore`, which a model may not run: it is the owner's). The records it replaces are copied first and the
answer names that copy, so restoring it by that name undoes the restore.
`latest` is the newest copy not taken by a restore, so it names the same copy
before and after one. The restore runs
where the store's writer is (the daemon when the terminal app is attached to
one) in a single SQLite transaction: the terminal app, the Agent and the
daemon that share the file see the restored records on their next read, and a
failure part way leaves the store unchanged. Semantic search then embeds again
only the records whose text differs from what the index held. The web UI's
Memory tab offers the same list and restore under "Copies and restore".

## GraphQL and projections

The knowledge domain exposes a GraphQL schema and two execution methods, alongside projection
targets such as overview pages, rollups, backlinks, source-health views, and exportable markdown
or wiki-style materializations. `knowledge.graphql.query` (`POST /api/knowledge/graphql`) runs
queries and changes nothing; `knowledge.graphql.mutate` (`POST /api/knowledge/graphql/mutate`,
admin) runs mutations, and over the relay with `relay.requireStepUpForMutations` on it needs a
passkey confirmation. Each refuses an operation of the other kind, naming the method that runs it.

The canonical store is the structured knowledge database. GraphQL and projections are query and presentation surfaces on top of it.

## Artifacts

Artifacts are first-class runtime objects. The artifact store handles markdown, text, JSON, CSV,
spreadsheets, PDFs, images, audio, video, and generated outputs. Artifacts can be ingested,
stored, retrieved, delivered through channels, and reused by knowledge and multimodal pipelines.

Large file uploads should use daemon upload bodies rather than JSON inline data:

- `POST /api/artifacts` accepts multipart/form-data with field name `file`.
- `POST /api/artifacts` accepts raw binary bodies with `Content-Type` set and the filename supplied with `filename` query params or `X-GoodVibes-Filename`.
- `POST /api/knowledge/ingest/artifact` accepts existing artifact references, daemon-local paths, remote URIs, multipart files, and raw binary uploads.
- Keep JSON `dataBase64` only for small inline control payloads. PDFs, photos, archives, and large documents should use multipart or raw upload bodies.

A remote URI is fetched only from a public address unless `network.remoteFetch.allowPrivateHosts` is on: every hop, redirects included, resolves the host and checks each address it resolves to, and the request goes to the checked address. A public name that resolves to a loopback or private address is refused with `400` `DESTINATION_REFUSED`, naming the address (`Artifact URI blocked by SSRF policy: host "<name>" resolves to 127.0.0.1, a loopback address. ...`). That setting and `storage.artifacts.maxBytes` take effect at the next upload or fetch, without a restart.

The host-side artifact storage cap is configured with `storage.artifacts.maxBytes`. The default is 512 MiB.

## Multimodal

The unified multimodal runtime handles image analysis, audio analysis through speech-to-text
(STT) backed paths, video analysis through keyframe and transcript fusion, and document analysis
through the extractors and packet building described above. It also supports packet building on
its own, optional write-back of results into structured knowledge, and provider routing across
the media and voice subsystems.

## Jobs and schedules

Ten knowledge job kinds can be run directly or saved as schedules through the runtime:

| Job | What it does |
| --- | --- |
| `lint` | Run knowledge health checks and refresh the issue queue |
| `reindex` | Re-run compile and structured memory sync across the current store |
| `refresh-stale` | Recrawl stale, failed, or aging remote sources |
| `refresh-bookmarks` | Recrawl bookmark and URL-list sources to refresh summaries and links |
| `sync-browser-history` | Index local browser history and bookmarks as metadata-first structured knowledge |
| `rebuild-projections` | Render and materialize the major derived markdown/wiki projections |
| `semantic-enrichment` | Extract durable facts, entities, wiki pages and gaps from indexed sources |
| `semantic-self-improvement` | Classify semantic gaps and repair eligible concrete subjects with corroborated source-backed ingest |
| `light-consolidation` | Score recent usage, refresh candidate promotions, and write a deterministic consolidation report |
| `deep-consolidation` | Run the full consolidation loop, including high-confidence memory promotion and deterministic reporting |

## Memory and knowledge, the place

One place fronts this whole subsystem in the terminal app and the Agent (the menu, `Ctrl+G` then `m`, or `/memory`), and the Library in the web app. Its tabs are the real things, read by themselves and read again when they change anywhere:

| Tab | What it shows, and what you do there |
| --- | --- |
| Memory | What the project remembers. Enter shows one record in full; correct it, say whether it is still right, change where it applies, link it, forget it; remember something (`n`), search, see what a task or a turn would be given, remember an incident or a setting's state |
| Proposals | What tidying memory proposes (two records that disagree, one twice, one out of date) |
| Copies and files | The copies of memory; replace memory with one; save memory to a file (a team handoff is the team's records), read a file, load one; keep memory as files in the project, see what your edits to them change, take the edits in; the search index |
| Sources, Entries, Issues, Jobs, Connectors | Your structured knowledge, one store for every program: add a page (`a`), a list of pages, bookmarks, a file, browser history, a saved artifact or through a connector; ask it (`q`), search it, see the map and what a task would get; review an issue; tidy and rebuild; stop a job |
| About you | What is known about you: correct a fact, put its earlier value back, forget it, add a line |
| Templates | Your prompt templates: see one, use it as your next message, edit it, delete it, keep your last message as one |

Every one of these is a capability that the model (`capability_find`, `capability_run`), an outside agent (`capabilities.find`, `capabilities.run`) and a script (`goodvibes do <id>`) reach the same way.

## Related docs

- [Providers and routing](providers-and-routing.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
- [Tools and commands](tools-and-commands.md)
