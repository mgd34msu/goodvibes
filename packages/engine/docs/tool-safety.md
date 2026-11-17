# Tool safety

> **Surface scope:** This document describes tool-call behavior for the **full surface (Bun runtime)**. See [Published Surface Matrix](./surfaces.md) for companion-surface constraints.

This guide covers how tool-call arguments move from raw streaming output through to your handler, what can go wrong at each step, and how to write tools that handle bad input gracefully. For the built-in tool catalog, registration requirements, and permission keys, see [Tool System](./tools.md).

---

## Owner-configured access

Tool admission uses explicit owner settings and deterministic checks. Jev
interprets work and verifies outcomes; its uncertainty or unavailability cannot
veto an otherwise valid tool call. Authentication, scopes, revocation, captured
input ownership, cancellation and schema validation still apply. The
autonomous decision contract
supersedes legacy semantic approval/escalation flows, including the historical
approval UI described later in this guide.

In the TUI, `goodvibes --yolo` selects the `yolo` execution mode for that
launch without saving the setting. The equivalent general override is
`--config permissions.mode=yolo`. Read,
find and repository-map tools honor that setting for access outside the project,
including resolved symlink targets. This setting does not grant operating-system
access or bypass the other authority checks above. See [CLI flags](../../../products/tui/docs/cli-flags.md#--yolo).

Built-in reads report an operation failure when every requested file fails,
retaining per-file diagnostics. Mixed results retain successful reads and
individual failures. Captured API inspection can continue past policy-denied
files while recording those failures; a blocked file is never evidence that its
contents were inspected.

## Tool-call lifecycle

When a provider streams a response that includes a tool call, the platform processes it in three stages:

### 1. Delta accumulation

Each streaming chunk may carry a partial tool name or a partial argument string. The provider's stream assembler accumulates these deltas into a single buffer as they arrive. For Anthropic-style streams this is `anthropic-sse-assembler.ts`, which appends each `input_json_delta` fragment onto the per-block argument buffer (`block.args += event.delta.partial_json`). `tool-formats.ts` is the wire-format parser, not a delta accumulator: it converts and parses already-assembled buffers. No JSON parsing occurs at this accumulation stage.

### 2. JSON parse with malformed-call drop

When the stream signals that a tool call is complete, the accumulated argument string is parsed. Provider adapters use the shared parser in `tool-formats.ts` for accumulated OpenAI-style calls and streamed Anthropic/Responses-style argument buffers; text-delimited calls take a parallel route through `extractTextToolCalls()` (described below) that funnels each extracted span through the same parser:

```ts
// shared provider parser
export function parseToolCallArguments(
  raw: string,
  context: ToolArgumentParseContext = {},
): Record<string, unknown> | undefined {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger.warn('tool-formats: failed to parse JSON tool arguments; dropping malformed tool call', {
      error: summarizeError(err),
      provider: context.provider,
      toolName: context.toolName,
      callId: context.callId,
    });
    return undefined;
  }
}
```

**Key behavior:** an empty accumulated argument string is treated as `{}` for no-argument tools. If the accumulated string is truncated or syntactically invalid JSON, the platform emits a `warn`-level log and drops that malformed tool call. The tool handler is not called with manufactured empty arguments.

**Text-token tool calls:** Some models (for example `kimi-k2-thinking` via `ollama-cloud`) emit tool calls as text tokens inside the content stream, using `<|tool_call_begin|>`-style delimiters, rather than as structured streaming deltas. `extractTextToolCalls()` in `tool-formats.ts` parses those delimited spans once the text content is assembled and routes each argument span through the same `parseToolCallArguments` boundary. A span whose JSON fails to parse is dropped exactly like a malformed structured call: the extractor skips it instead of emitting a tool call with manufactured arguments.

### 3. Handler dispatch

Only successfully parsed tool-call arguments are passed to handlers. If a provider reports a tool-call stop reason but no parseable tool calls remain, the orchestrator treats the response as malformed and emits the existing tool-reconciliation warning path instead of dispatching a handler with `{}`.

All model-originated tool calls should pass through the shared tool execution boundary before a handler is invoked. That boundary applies permission checks, Pre/Post/Fail hooks, runtime tool events, and normalized error handling. TUI/orchestrator turns and companion remote chat use this shared path; embedders that provide a `ToolRegistry` without a `PermissionManager` to companion chat receive denied tool results instead of direct handler execution.

Built-in batch tools bound how many items run at the same time. They do not limit how many items one call may carry; every item is processed, a few at a time:

| Tool | Concurrency |
|---|---:|
| `fetch` | 5 concurrent requests |
| `exec` | 3 concurrent commands |
| `find` | 5 concurrent queries |
| `read` | 8 concurrent reads |

---

## Why argument validation still matters

Most tool argument failures fall into two categories:

| Cause | Result |
|---|---|
| LLM produces partial/truncated JSON (common with aggressive max-token limits) | Malformed tool call is dropped before handler dispatch |
| LLM produces semantically wrong JSON (wrong keys, wrong types) | Handler receives a structurally valid but incorrect object |
| Network error mid-stream truncates the argument buffer | Malformed tool call is dropped before handler dispatch |
| LLM produces valid JSON with extra or missing fields | Handler receives the object as-is (see below for names the registry adjusts or reports) |

Before dispatch the registry makes two name-level adjustments and reports both to the model:

- A key spelled in the other case style of a declared parameter (`timeoutMs` for `timeout_ms`, `dry_run` for `dryRun`) is renamed to the declared name, at any nesting level, and the result starts with an `[Auto-repaired: …]` note. A declared key that is already present is never overwritten.
- Other tools' names for the same thing are accepted too and renamed to the one the tool declares: `cwd`/`working_directory` for `working_dir`, `fail_fast` for `stop_on_error`, `limit`/`page_size` for `max_results`, `tool_name` for `tool`, `cli_command`/`command_name` for `command`, `session` for `session_id`; an output-detail value sent as `verbosity`, `view` or `detail` where the tool declares `output.format` (or the reverse) moves to the declared place when its value fits there; and kebab, snake and spaced spellings of an enum value (`add_item`, `API-Spec`) are normalised.
- A key the schema does not declare (where the schema does not allow extra keys), at the top level, inside nested objects, or inside array items whose shape is one object schema (not a union), is passed through unchanged and named in the result: a JSON object result gains a leading `parameter_warnings` array; any other result gains a first line `[Ignored parameters: …]`. Each entry suggests a close declared name when one exists.

The platform rejects malformed JSON before tool dispatch, but it does not schema-validate third-party arguments. It cannot know whether a valid JSON object is correct for your tool. **Validation is the tool author's responsibility.**

---

## Recommendations for tool authors

### Always validate tool input

Every tool handler should validate its arguments before using them. Do not assume that because the LLM was given a schema, it produced valid output conforming to that schema.

### Example: validation with Zod

```ts
import { z } from 'zod';

const SearchArgsSchema = z.object({
  query: z.string().min(1, 'query is required'),
  limit: z.number().int().min(1).max(100).default(10),
});

async function handleSearch(rawArgs: Record<string, unknown>) {
  const result = SearchArgsSchema.safeParse(rawArgs);

  if (!result.success) {
    // Return a structured error the LLM can reason about and retry
    return {
      error: 'invalid_arguments',
      details: result.error.flatten(),
    };
  }

  const { query, limit } = result.data;
  // ... proceed with validated args
}
```

Returning a structured error object (rather than throwing) allows the model to observe the failure and potentially self-correct on the next turn.

### Example: validation with AJV

```ts
import Ajv from 'ajv';

const ajv = new Ajv({ coerceTypes: true });
const validate = ajv.compile({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
  },
  required: ['query'],
});

async function handleSearch(rawArgs: Record<string, unknown>) {
  if (!validate(rawArgs)) {
    return { error: 'invalid_arguments', details: validate.errors };
  }
  // rawArgs is coerced and valid here
}
```

### Fail loudly

Avoiding `throw` in handler code is reasonable (prevents unhandled promise rejections from aborting the turn), but returning a meaningful error payload is always better than ignoring missing fields. Returning `{}` or `null` gives the model nothing to act on.

---

## Detecting dropped parse failures

When the platform drops a malformed tool call due to a parse error, a log entry is emitted at `warn` level. To catch this in production:

- Configure your observability stack to alert on `tool-formats: failed to parse JSON tool arguments; dropping malformed tool call`
- Review malformed-stop-reason reconciliation events when a provider reported tool use but no parseable tool calls remained
- Note that `UserAuthManager.inspect()` returns a `LocalAuthSnapshot` whose `sessionCount` counts authenticated auth sessions, not chat or tool-call sessions. It does not correlate with dropped tool calls and should not be used to diagnose parse regressions

---

## Tool contract verification

Every tool is checked where it enters: `ToolRegistry.register` refuses a
definition with a malformed parameter schema, a missing name or description,
or a `category` that is not one of `read`, `write`, `execute`, `delegate`. The
refusal names each problem.

A tool's permission category is one field on its definition (`category`); an
engine tool's comes from one table (`ENGINE_TOOL_CATEGORIES`), and a tool that
declares none is classed `delegate`. The gate, `/tool verify` and the policy
evaluators read that one value.

`/tool verify-all` runs the code checks over every registered tool and asks no
decision model. `/tool verify <name>` also asks whether that one tool's
description explains what it does and when to use it (one reading per distinct
description, remembered). The timeout, output-policy and idempotency checks
apply only to tools built for the phased executor (`PhasedTool`).

Handler-level argument validation is still required for untrusted runtime input.
Contract verification prevents malformed tools from being registered; it does
not replace validation inside a handler for model-provided arguments.

## Durable approval rules and deny-as-feedback

Approval prompts carry remember tiers, most specific first. The tiers are
this exact command, this command class (e.g. every `git ...`), edits under
the asked path's directory, always for this tool in this project, or
session-only.
A generalizing tier writes a durable user-origin rule
(`UserPermissionRuleStore`, one JSON file per project) that the permission
manager consults before ever prompting. The tenth `git commit` never
re-asks once "git commands" was granted, across restarts. Rules are listed
and deleted through the `permissions.rules.list` / `permissions.rules.delete`
gateway verbs (deleting a grant makes matching asks prompt again).

Allow rules use conservative batch semantics: every command (or edited path)
in a call must be covered, so a mixed batch never rides in on a partial
grant. Deny rules fire on any covered element, and a matching deny rule wins
over any matching allow rule, so a later "deny always" holds even under an
older, broader grant.

The list stays one rule per decision. Remembering an answer drops the rules of
this project it now covers with the same effect (exact commands inside a newly
remembered command class, edits under a directory inside a newly remembered
one, anything under a whole-tool rule), and writes nothing when a stored rule
already covers it. After three exact-command answers for one command class in
a project, the next prompt offers that class first. An answer to an owner-only
item is never merged into a rule that was not one.

The answer is remembered from the next call on; the call it answered runs
as approved. A durable rule is written to disk at once, so it survives a
restart that follows immediately. A session-only answer is kept in memory,
keyed like the session cache (an exec command class, or the exact set of
edited paths). An answer that edited the arguments remembers nothing. A
remembered allow suppresses the next ask wherever an ask is the only thing
left to decide (Classic operation); in a decision mode, calls that still need
the owner (critical or irreversible stakes, a failed boundary check) keep
asking. A remembered deny is enforced in every mode. Those asks carry
`rememberEffect: 'owner-asked-again'` so a surface does not promise that "Allow
for session" skips them. A later "deny for session" or deny rule applies from
the next decision on; it does not stop a call with the same key that was already
admitted and is running.

Per-call bookkeeping is bounded. A settled call drops its pending owner edit
and its admission counter at once. Its replay claim is kept for the 4,096 calls
that settle after it, then forgotten: a source id is one (session, turn, call)
tuple, so it cannot be presented again outside its own turn. Past 10,000
pending owner edits the oldest is dropped and that call is asked again.

If the rules file cannot be read, tool calls are refused with a message
naming the file until it is fixed or removed; every call retries the load,
so a repaired file takes effect without a restart. Yolo consults no
remembered rule and is not refused.

Denials are feedback, not turn-enders. A declined tool call resolves with a
structured user-declined result, including the user's optional reason
("The user said: ..."), in a continuing turn, so the model adapts instead
of dying. Duplicate in-flight asks coalesce to one prompt, and a remembered
decision sweeps every queued ask its rule covers.

## Settings changes through the daemon

A settings change over the daemon is captured, then applied once. If the owner
refuses before applying anything, the refusal carries a value-free reason, and
the `goodvibes_settings` result reports `status: "refused"` with it:

| Reason | Meaning | Next step |
|---|---|---|
| `stale` | the setting, its owner or the daemon changed, or the capture expired | read the setting, capture again |
| `spent` | this capture was already used | read the setting to see whether the earlier use took effect |
| `managed` | managed policy locks the setting | stop; only the policy owner can change it |
| `read-only` | the settings owner cannot write here | stop; use a writable owner |
| `owner-fault` | a settings store (pairing store, configuration lock) is faulted or briefly busy | retry shortly; check the daemon log if it persists |

A change to configuration waits a short, bounded time when another live process
holds the configuration lock, then refuses with `owner-fault` naming the lock
and the process. A refused change leaves the running settings and every
outstanding admission untouched. A lock left by a process that no longer exists
is reclaimed; a lock whose holder is unknown is never removed automatically.

Clearing a credential writes the setting first and removes the stored
credential second. A failure in between leaves an unreferenced stored
credential, never a setting that points at a credential that is gone; the
receipt lists the setting as completed and the credential path as uncertain.
