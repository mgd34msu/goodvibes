# Decision-model policies

The `judgment.policy` setting controls decision-model use independently of tool
permissions. In TUI or Agent, open `/settings`, choose **Judgment**, then
**Decision models**. Choose **Default - On**, **Preferred**, or **Classic - Off**
from the picker. WebUI exposes the same policy in its Judgment settings.

Choose **Decision provider** and **Decision model** in that category to configure
Jev, Clef, Clef-flash, DiffusionGemma Jev, Kev-9B, Laya, or a compatible custom
model. The terminal setup asks for the deployment endpoint and a credential
reference. Use an environment-variable name or secret-store entry name, never
the key value. Local deployments can explicitly select no authentication.

**Decision fallback chain** adds, edits, removes, and orders backup targets.
Each target can use its own model, protocol, endpoint, and credential reference.
WebUI provides editable fallback rows and an Advanced JSON view.

Execution permissions are in **Permissions → Execution permissions**, including
**YOLO**. Choose the decision policy and execution permissions independently.
The daemon configuration command also exposes these settings.

| Policy | Behavior |
| --- | --- |
| Default - On | Use the configured hosted/local decision chain; halt if no decision model is available. |
| Preferred | Use decision models; continue in Classic after actual availability exhaustion. |
| Classic - Off | Use Classic from startup, making zero decision-model requests. |

Classic supports conversation, tools, editing, command and test execution, final
responses and saved-session recovery. Ordinary conversation models are still
required. The Decision Router uses its General target without categorization.

Tool permissions remain separate. `safe-jev` asks the owner during Classic;
explicit YOLO keeps its meaning. Authentication, workspace boundaries, secret
handling, spending limits, cancellation and duplicate-execution protection stay
in force. Results identify Classic operation rather than claiming model verification.

Preferred preserves conversation history and completed work without replaying
actions. A refusal, malformed response, privacy rejection, cancellation or stale
authority does not trigger fallback. An action already refused stays refused.

Local knowledge ingestion/search, explicit review and links, structural planning,
diagnostics, credential masking, speech and catalog browsing remain available.
Autonomous contract execution, independent semantic knowledge verification,
merchant/checkout interpretation and semantic recommendations or grading need
decision models and report that limitation in Classic.

Installation does not require a live decision-model connection. Configure
provider accounts in the application. Existing installations retain Default - On
unless the owner changes it.

## Decision Router

Choose **Provider → Decision Router categories** in the terminal settings to
assign each category an answer provider, model and effort level. Set **General**
as the catch-all; unassigned categories use General. WebUI provides the same
category controls, custom categories and routing-context limits. Advanced
terminal configuration exposes custom categories and context limits as well.

Select **Decision Router / auto** in the ordinary model picker to enable this
routing for the conversation. Selecting other providers adds no categorization
calls. Classification uses bounded context; the chosen answer model receives
the conversation and tool history.
