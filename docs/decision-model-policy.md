# Decision-model policies

The `judgment.policy` setting controls decision-model use independently of tool
permissions. Choose it in Settings or with the daemon configuration command.

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
