# Decision Router

Status: implemented on the v3 development branch; integrated release qualification is in progress.

Select `decision-router:auto` explicitly to categorize a user turn and use its
configured answering model. Selecting another provider adds no categorization
calls. Configure `provider.decisionRouter` through Settings; the WebUI offers a
category editor, and terminal settings accept the structured setting. Decision
backends and their credentials remain under `judgment.*`.

The built-in categories are lookup/navigation, coding/implementation,
analysis/decisions, documentation/writing, summarization/extraction, General,
debugging/diagnosis, review/verification, research and data analysis. Each has an
editable description and an optional provider/model/effort target. Add custom
categories with their own descriptions. General must name an answering model;
empty categories use it. A target cannot be another Decision Router. An answer
provider failure does not silently substitute a different category's target.

For example, the stored setting can begin as:

```json
{
  "categories": {
    "general": { "target": { "provider": "openrouter", "model": "openrouter/free" } },
    "coding-implementation": { "target": { "provider": "your-provider", "model": "your-code-model", "effort": "high" } }
  }
}
```

Other categories remain present with empty targets. Model ids and credentials
must match the deployment. Supported effort levels come from the actual model;
an unsupported request is reduced to a supported level or omitted with an
explanation, using the existing per-model effort contract.

Classification receives a bounded preview of the latest request, a bounded active
task hint, selected file identities, and limited recent user/assistant text. It
excludes tool payloads and image bytes. Omitted content is explicitly marked. An
uncertain classification expands the preview once within the configured budget;
persistent uncertainty uses General. A brief lookup does not replace the active
task hint. This preview is intentionally separate from authority-bearing evidence.

The answering model receives the normal conversation, tools and attachments,
subject to the existing context policy for that actual model. The saved transcript
remains complete. The main turn resolves its target before context preflight,
then pins it across streams and tool rounds. Agent tasks and companion chat carry
the same turn ownership. The next user turn is categorized again.

Route notices name the selected category, actual provider/model, General fallback
and effort adjustment. Main-session usage and pricing use the actual target.
Companion replies retain route and usage metadata. Decision-log entries separately
retain the decision model and wire-attempt lineage, so categorization traffic and
answering traffic can be inspected separately.

If no configured decision backend can answer, the port reports unavailability,
explains which configuration to check, and stops the operation. It does not invent
a category to recover from an outage. Deterministic tests enforce no extra routing
calls for ordinary providers, zero model-inventory classification calls, one
classification for a normal routed turn and at most one uncertainty expansion.
These checks verify application behavior; live model calibration is optional.
