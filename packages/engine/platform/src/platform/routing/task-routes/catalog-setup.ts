/**
 * Setup, host, settings, model, context, memory and Personal Ops routes.
 * Every label, surface, outcome, route string and policy is the agent's
 * wording; the keyword checks that once chose a variant are slot readings
 * (slots.ts), and whether a route applies at all is the route selector's
 * reading (route-selector.ts).
 */
import { quote } from './text.js';
import type { TaskRouteEntry } from './types.js';

const setupAndHostReadiness: TaskRouteEntry = {
  id: 'setup-and-host-readiness',
  description: 'First-run install, onboarding, bootstrap, starting the daemon or connected host, auth tokens, or setup smoke evidence: getting the assistant reachable at all.',
  build: () => ({
    id: 'setup-and-host-readiness',
    label: 'Guided setup or connected-host repair',
    userSurface: 'System, Setup',
    userOutcome: 'Get the assistant reachable and working before asking the user to diagnose topology.',
    why: 'The request is about install, first-run setup, host availability, auth, token, or setup smoke evidence.',
    modelRoute: 'setup action:"status" includeParameters:true',
    inspectRoute: 'host action:"status" includeParameters:true',
    userRoute: 'System, Setup (the menu, Ctrl+G then m)',
    requiresConfirmation: false,
    supportingRoutes: [
      'setup action:"item" setupItemId:"connected-host-service"',
      'setup action:"token" confirm:true explicitUserRequest:"..."',
      'setup action:"smoke" confirm:true explicitUserRequest:"..."',
      'host action:"services" includeParameters:true',
    ],
    policy: 'Setup inspection is read-only; token repair, smoke execution, service lifecycle, and finish markers stay confirmed.',
  }),
};

const hostRuntimeDiagnostics: TaskRouteEntry = {
  id: 'host-runtime-diagnostics',
  description: 'Health, status, doctor, readiness or compatibility diagnostics of the daemon, connected host, services or control plane that are already set up.',
  build: () => ({
    id: 'host-runtime-diagnostics',
    label: 'Connected host diagnostics',
    userSurface: 'System, Setup',
    userOutcome: 'Inspect daemon, host, service, and compatibility health through read-only connected-host diagnostics.',
    why: 'The request asks for daemon, host, service, health, doctor, readiness, or compatibility diagnostics.',
    modelRoute: 'host action:"status" includeParameters:true',
    inspectRoute: 'host action:"capabilities" includeParameters:true',
    userRoute: 'System, Setup (the menu, Ctrl+G then m)',
    requiresConfirmation: false,
    supportingRoutes: [
      'host action:"services" includeParameters:true',
      'host action:"methods" includeParameters:true',
      'setup action:"repair" target:"host" includeParameters:true',
      'setup action:"smoke" confirm:true explicitUserRequest:"..."',
    ],
    policy: 'Host diagnostics are read-only. Service lifecycle, setup smoke, token repair, and operator methods remain explicit confirmed routes.',
  }),
};

const goodvibesSettingsImport: TaskRouteEntry = {
  id: 'goodvibes-settings-import',
  description: 'Importing the settings of an existing GoodVibes install (the terminal app, the TUI) into the agent.',
  build: () => ({
    id: 'goodvibes-settings-import',
    label: 'Give the Agent the terminal app\'s settings',
    userSurface: 'System, Setup, Import settings',
    userOutcome: 'Each setting the terminal app has set that the Agent holds differently is set the same in the Agent; sign-ins are already shared by both programs.',
    why: 'The request asks to import existing GoodVibes settings.',
    modelRoute: 'capability_run id:"settings.copy-from-terminal-app"',
    inspectRoute: 'capability_find need:"give the Agent the settings I set in the terminal app"',
    userRoute: 'System, Setup, Import settings (the menu, Ctrl+G then m)',
    requiresConfirmation: true,
    supportingRoutes: [
      'settings action:"import"',
    ],
    policy: 'One capability, settings.copy-from-terminal-app: a setting that loosens a protection is copied only when chosen (security:"yes"); the terminal app\'s settings are not changed.',
  }),
};

const agentSettingsConfiguration: TaskRouteEntry = {
  id: 'agent-settings-configuration',
  description: "Finding, reading or changing one of the agent's own settings, configuration values or preferences (theme, behaviour toggles), not importing them from GoodVibes.",
  build: (request, slots) => ({
    id: 'agent-settings-configuration',
    label: 'Agent settings inspection or change',
    userSurface: 'The settings screen',
    userOutcome: 'Find the right Agent-owned setting and keep every setting mutation explicit and confirmed.',
    why: 'The request mentions settings, configuration, or preferences without asking for GoodVibes TUI import.',
    modelRoute: `settings action:"list" query:${quote(request)} includeParameters:true`,
    inspectRoute: 'settings action:"list" includeParameters:true',
    userRoute: 'The settings screen (/settings, or S in System)',
    requiresConfirmation: slots.changes,
    missingFields: slots.changes ? ['setting key', 'new value or reset target', 'confirmation'] : undefined,
    supportingRoutes: [
      'settings action:"get" target:"..." includeParameters:true',
      'settings action:"set" key:"..." value:... confirm:true explicitUserRequest:"..."',
      'settings action:"reset" key:"..." confirm:true explicitUserRequest:"..."',
    ],
    policy: 'Settings search and inspection are read-only. Set/reset/import effects mutate only Agent-owned settings and require confirmation.',
  }),
};

const localModelSmokeCheck: TaskRouteEntry = {
  id: 'local-model-smoke-check',
  description: 'Checking, smoke-testing or probing whether locally served model servers or endpoints are up and answering.',
  build: (request) => ({
    id: 'local-model-smoke-check',
    label: 'Local model server smoke check',
    userSurface: 'Models and providers',
    userOutcome: 'Check local model endpoints only through the confirmed smoke route with clear success criteria.',
    why: 'The request asks to check, smoke, or verify local model server health.',
    modelRoute: `models action:"smoke" query:${quote(request)} includeParameters:true`,
    inspectRoute: 'models action:"local" query:"local server health" includeParameters:true',
    userRoute: 'Models and providers (the menu, Ctrl+G then m)',
    requiresConfirmation: true,
    missingFields: ['local endpoint or route id when multiple candidates exist', 'timeout when not default', 'confirmation before probing local servers'],
    supportingRoutes: [
      `models action:"local" query:${quote(request)} includeParameters:true`,
      'models action:"route" target:"local" includeParameters:true',
      'setup action:"item" setupItemId:"local-model-readiness"',
    ],
    policy: 'Local model discovery is read-only. Smoke checks may contact local endpoints and require confirm:true plus explicitUserRequest.',
  }),
};

const localModelCookbook: TaskRouteEntry = {
  id: 'local-model-cookbook-route',
  description: 'Choosing, recommending, downloading, installing or serving a model that runs locally on this machine (local model runners, cookbook recipes, hardware fit).',
  build: (request, slots) => {
    const localEffect = slots.changes || slots.starts;
    return {
      id: 'local-model-cookbook-route',
      label: 'Local model cookbook and endpoint readiness',
      userSurface: 'Models and providers',
      userOutcome: 'Recommend local model recipes and inspect endpoint readiness before setup or smoke effects.',
      why: 'The request mentions local models, Ollama, llama.cpp, vLLM, LM Studio, cookbook recipes, or hardware fit.',
      modelRoute: `models action:"local" query:${quote(request)} includeParameters:true`,
      inspectRoute: 'models action:"status" query:"local" includeParameters:true',
      userRoute: 'Models and providers (the menu, Ctrl+G then m)',
      requiresConfirmation: localEffect,
      missingFields: localEffect ? ['selected recipe or endpoint', 'install/start/smoke intent', 'confirmation before local setup or server probing'] : undefined,
      supportingRoutes: [
        'models action:"route" target:"local" includeParameters:true',
        'models action:"smoke" query:"local" confirm:true explicitUserRequest:"..."',
        'agent_model_compare mode:"compare" confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Cookbook and endpoint readiness are read-only. Downloads, server starts, benchmark runs, route updates, and local smoke checks remain separate confirmed effects.',
    };
  },
};

const modelProviderAccount: TaskRouteEntry = {
  id: 'model-provider-account-posture',
  description: 'A hosted model provider account: connecting it, subscriptions, sign-in, API keys, billing or provider auth state.',
  build: (request, slots) => {
    const providerId = slots.modelProvider;
    return {
      id: 'model-provider-account-posture',
      label: 'Model provider account and subscription posture',
      userSurface: 'Models and providers',
      userOutcome: 'Inspect provider account, subscription, and auth readiness before changing credentials or model routes.',
      why: 'The request mentions model providers, subscriptions, provider auth, or API keys.',
      modelRoute: providerId
        ? `models action:"provider" providerId:"${providerId}" includeParameters:true`
        : `models action:"providers" query:${quote(request)} includeParameters:true`,
      inspectRoute: 'models action:"providers" includeParameters:true',
      userRoute: 'Models and providers, Providers tab (its account, the ways it is reached, how to fix it)',
      requiresConfirmation: slots.changes,
      missingFields: slots.changes ? ['provider id', 'credential or subscription setup route', 'confirmation before storing credentials or changing routes'] : undefined,
      supportingRoutes: [
        'settings action:"list" query:"provider model api key" includeHidden:true',
        'models action:"status" includeParameters:true',
        'models action:"route" target:"default" includeParameters:true',
      ],
      policy: 'Provider inspection is read-only. Credential storage, provider refreshes, and route changes stay on explicit confirmed settings or model-route effects.',
    };
  },
};

const modelRouteReadiness: TaskRouteEntry = {
  id: 'model-route-readiness',
  description: 'Choosing or switching which model route to use for a kind of job from the models\' facts: context window, tool support, vision, cost, latency or privacy, without running them against each other.',
  build: (request, slots) => ({
    id: 'model-route-readiness',
    label: 'Model route fit and readiness',
    userSurface: 'Models and providers',
    userOutcome: 'Inspect the best model route for context, tools, vision, cost, latency, and privacy before changing defaults.',
    why: 'The request asks to choose, compare, or inspect model route fit.',
    modelRoute: `models action:"route" query:${quote(request)} includeParameters:true`,
    inspectRoute: 'models action:"status" includeParameters:true',
    userRoute: 'Models and providers (the menu, Ctrl+G then m)',
    requiresConfirmation: slots.changes,
    missingFields: slots.changes ? ['selected model route id', 'confirmation before route change'] : undefined,
    supportingRoutes: [
      'models action:"status" includeParameters:true',
      'models action:"providers" includeParameters:true',
      'agent_model_compare mode:"compare" confirm:true explicitUserRequest:"..."',
    ],
    policy: 'Route inspection is read-only. Model comparisons and winner/default-route changes are separate confirmed routes with saved evidence.',
  }),
};

const modelProviderRouting: TaskRouteEntry = {
  id: 'model-provider-routing',
  description: 'A general overview of model access: which models and providers are available and ready, whether hosted or local, when no narrower model route is asked for.',
  build: () => ({
    id: 'model-provider-routing',
    label: 'Model/provider route readiness',
    userSurface: 'Models and providers',
    userOutcome: 'Choose or diagnose model access without asking the user to know provider internals.',
    why: 'The request is about model choice, provider accounts, subscriptions, local models, or context-window fit.',
    modelRoute: 'models action:"status" includeParameters:true',
    inspectRoute: 'models action:"route" target:"..." includeParameters:true',
    userRoute: 'Models and providers (the menu, Ctrl+G then m)',
    requiresConfirmation: false,
    supportingRoutes: [
      'models action:"local"',
      'models action:"providers"',
      'models action:"smoke" confirm:true explicitUserRequest:"..."',
    ],
    policy: 'Model inspection and cookbook guidance are read-only; local smoke checks and route changes stay explicit confirmed actions.',
  }),
};

const personalityAndContext: TaskRouteEntry = {
  id: 'personality-and-context',
  description: "The assistant's personality, tone, style or persona (VIBE.md, SOUL.md), or the project instruction files it reads (AGENTS.md, CLAUDE.md, .cursorrules, project context).",
  build: (_request, slots) => {
    const contextRoute = slots.instructionFiles ? 'context action:"files" includeParameters:true' : 'vibe action:"status" includeParameters:true';
    return {
      id: 'personality-and-context',
      label: 'Personality and project context',
      userSurface: 'Memory and knowledge',
      userOutcome: 'Inspect or update how the assistant should behave without hidden prompt surprises.',
      why: 'The request mentions VIBE.md, personality, personas, tone, or project instruction files.',
      modelRoute: contextRoute,
      inspectRoute: contextRoute,
      userRoute: 'Memory and knowledge, and This conversation (the menu, Ctrl+G then m)',
      requiresConfirmation: slots.changes,
      supportingRoutes: [
        'vibe action:"show"',
        'vibe action:"init" confirm:true explicitUserRequest:"..."',
        'context action:"prompt" includeParameters:true',
        'memory action:"curator" includeParameters:true',
      ],
      policy: 'Context/personality inspection is read-only; VIBE.md creation or persona import requires confirmation and secret scanning.',
    };
  },
};

const externalMemoryProvider: TaskRouteEntry = {
  id: 'external-memory-provider-posture',
  description: 'An external or cross-session memory provider or backend: connecting one, syncing, importing or exporting memory through it.',
  build: (_request, slots) => {
    const providerId = slots.memoryProvider;
    return {
      id: 'external-memory-provider-posture',
      label: 'External memory provider setup posture',
      userSurface: 'Memory and knowledge',
      userOutcome: 'Inspect provider readiness and required daemon/platform contracts before promising external cross-session memory.',
      why: 'The request mentions an external memory provider, backend, sync, import/export, or a named provider such as Honcho, Mem0, or Supermemory.',
      modelRoute: providerId
        ? `memory action:"provider" providerId:"${providerId}" includeParameters:true`
        : 'memory action:"status" query:"external memory provider" includeParameters:true',
      inspectRoute: providerId
        ? `host action:"capability" query:"${providerId} memory provider"`
        : 'memory action:"status" query:"external memory provider" includeParameters:true',
      userRoute: 'Memory and knowledge, and This conversation (the menu, Ctrl+G then m)',
      requiresConfirmation: slots.changes,
      missingFields: [
        ...(providerId ? [] : ['provider id or backend name']),
        'published setup/status/read/write/receipt contract before external memory is considered ready',
        ...(slots.changes ? ['confirmation for any provider write, sync, import, export, or credential effect'] : []),
      ],
      supportingRoutes: [
        'memory action:"status" query:"external memory provider" includeParameters:true',
        'memory action:"provider" providerId:"honcho|mem0|supermemory" includeParameters:true',
        'host action:"capability" query:"memory provider"',
        'agent_harness mode:"mcp_servers" query:"memory provider"',
        'settings action:"list" query:"memory" includeHidden:true',
      ],
      policy: 'External memory posture is read-only. Agent-local memory remains the active path until platform/daemon provider setup/status/read/write/sync contracts with secret-safe receipts are published for Agent to consume.',
    };
  },
};

const memoryLearning: TaskRouteEntry = {
  id: 'memory-learning',
  description: "The agent's own memory and learning: remembering, recalling or forgetting facts, and reviewing learned skills and routines.",
  build: (_request, slots) => ({
    id: 'memory-learning',
    label: 'Memory, routines, skills, and learning review',
    userSurface: 'Memory and knowledge',
    userOutcome: 'Make durable learning reviewable, sourced, and reversible.',
    why: 'The request is about memory, recall, skills, routines, or external memory providers.',
    modelRoute: 'memory action:"status" includeParameters:true',
    inspectRoute: 'memory action:"curator" includeParameters:true',
    userRoute: 'Memory and knowledge, and This conversation (the menu, Ctrl+G then m)',
    requiresConfirmation: slots.changes,
    supportingRoutes: [
      'memory action:"list"',
      'memory action:"search" query:"..."',
      'memory action:"candidate" candidateId:"..."',
      'agent_learning_consolidation mode:"preview"',
    ],
    policy: 'Memory reads and review queues are safe; durable memory writes or consolidation phases require reviewed confirmed routes.',
  }),
};

/** The Personal Ops lane route strings for a request's lane. */
function personalOpsRoutes(request: string, lane: string | null) {
  return {
    laneRoute: lane ? `personal_ops action:"lane" laneId:"${lane}" includeParameters:true` : 'personal_ops action:"status" includeParameters:true',
    laneQueueQuery: lane ? ` query:"${lane}"` : '',
    intakeRoute: `personal_ops action:"intake" query:${quote(request)} includeParameters:true`,
  };
}

const personalOpsConnectorSetup: TaskRouteEntry = {
  id: 'personal-ops-connector-setup',
  description: 'Setting up, connecting or repairing the email or calendar connector itself (Gmail, IMAP/SMTP, CalDAV, an MCP connector), not using the mail or calendar.',
  build: (request, slots) => {
    const { laneRoute, intakeRoute } = personalOpsRoutes(request, slots.lane);
    return {
      id: 'personal-ops-connector-setup',
      label: 'Personal Ops connector setup posture',
      userSurface: 'Mail, calendar and channels',
      userOutcome: 'Inspect the inbox or calendar connector lane before promising fresh provider data.',
      why: 'The request mentions Gmail, IMAP/SMTP, CalDAV, or an email/calendar connector setup task.',
      modelRoute: laneRoute,
      inspectRoute: 'personal_ops action:"status" includeParameters:true',
      userRoute: 'Mail, calendar and channels (the menu, Ctrl+G then m)',
      requiresConfirmation: slots.changes,
      missingFields: slots.changes ? ['connector/provider choice', 'credential or MCP setup route', 'confirmation before any account or secret mutation'] : undefined,
      supportingRoutes: [
        intakeRoute,
        'agent_harness mode:"mcp_servers" query:"email calendar" includeParameters:true',
        'settings action:"list" query:"gmail imap smtp caldav" includeHidden:true',
      ],
      policy: 'Connector setup posture is read-only. Account connection, secret storage, MCP trust, and provider effects remain on explicit confirmed setup routes.',
    };
  },
};

const personalOpsDailyBriefing: TaskRouteEntry = {
  id: 'personal-ops-daily-briefing',
  description: "A daily or morning briefing, or a summary of today's agenda: one overview across calendar, inbox, tasks and reminders.",
  build: (request) => ({
    id: 'personal-ops-daily-briefing',
    label: 'Personal Ops daily briefing',
    userSurface: 'Mail, calendar and channels',
    userOutcome: 'Start with one read-only daily plan across agenda, inbox, tasks, reminders, routines, delivery, and autonomy.',
    why: 'The request asks for a brief, briefing, agenda summary, or today view.',
    modelRoute: `personal_ops action:"briefing" query:${quote(request)} includeParameters:true`,
    inspectRoute: 'personal_ops action:"status" includeParameters:true',
    userRoute: 'Work and agents, O (your briefing)',
    requiresConfirmation: false,
    supportingRoutes: [
      'personal_ops action:"queue" includeParameters:true',
      'personal_ops action:"lane" laneId:"calendar" includeParameters:true',
      'autonomy action:"queue"',
      'schedule action:"list" limit:5',
    ],
    policy: 'Briefing is read-only. Live inbox/calendar reads, reminder creation, sends, edits, and schedule mutations stay on their owning confirmed routes.',
  }),
};

const personalOpsReviewQueue: TaskRouteEntry = {
  id: 'personal-ops-review-queue',
  description: 'Reviewing inbox threads or calendar events that were already saved or queued for review earlier, without fetching anything new.',
  build: (request, slots) => {
    const { laneRoute, laneQueueQuery, intakeRoute } = personalOpsRoutes(request, slots.lane);
    return {
      id: 'personal-ops-review-queue',
      label: 'Personal Ops saved review queue',
      userSurface: 'Mail, calendar and channels',
      userOutcome: 'Review saved inbox threads and calendar events before doing fresh reads or provider effects.',
      why: 'The request asks for saved Personal Ops review queues or previously captured inbox/calendar cards.',
      modelRoute: `personal_ops action:"queue"${laneQueueQuery} includeParameters:true`,
      inspectRoute: laneRoute,
      userRoute: 'Mail, calendar and channels, Inbox and Calendar',
      requiresConfirmation: false,
      supportingRoutes: [
        intakeRoute,
        'personal_ops action:"read" laneId:"inbox|calendar" recordId:"..." fields:{...} confirm:true explicitUserRequest:"..."',
        'agent_artifacts mode:"list" query:"personal ops review"',
      ],
      policy: 'Review queue inspection is read-only. Refreshing from a provider or applying send/edit/archive/RSVP effects requires a selected connector route and confirmation.',
    };
  },
};

const personalOpsFreshRead: TaskRouteEntry = {
  id: 'personal-ops-fresh-read-plan',
  description: 'Fetching fresh live data from the email or calendar provider now: refresh, sync, unread mail, upcoming events.',
  build: (request, slots) => {
    const { laneRoute, intakeRoute } = personalOpsRoutes(request, slots.lane);
    return {
      id: 'personal-ops-fresh-read-plan',
      label: 'Personal Ops fresh provider read plan',
      userSurface: 'Mail, calendar and channels',
      userOutcome: 'Select the safest read-only connector operation before fetching fresh inbox or calendar data.',
      why: 'The request asks to refresh, sync, fetch, or inspect unread/upcoming personal provider data.',
      modelRoute: intakeRoute,
      inspectRoute: laneRoute,
      userRoute: 'the conversation: say what you want done',
      requiresConfirmation: true,
      missingFields: ['lane id', 'read-only connector operation record id', 'bounded input fields', 'confirmation before reading live personal provider data'],
      supportingRoutes: [
        laneRoute,
        'personal_ops action:"read" laneId:"inbox|calendar" recordId:"..." fields:{...} confirm:true explicitUserRequest:"..."',
        'personal_ops action:"queue" includeParameters:true',
      ],
      policy: 'Fresh provider reads are never implicit. The planner only selects the lane; one read-only connector operation still needs exact fields, confirm:true, and explicitUserRequest.',
    };
  },
};

const personalOpsIntake: TaskRouteEntry = {
  id: 'personal-ops-intake-route',
  description: 'Working through personal email, calendar, notes or to-do tasks: triaging the inbox, drafting or sending replies, RSVPs, adding notes or tasks.',
  build: (request, slots) => {
    const { laneRoute, intakeRoute } = personalOpsRoutes(request, slots.lane);
    return {
      id: 'personal-ops-intake-route',
      label: 'Personal Ops request intake',
      userSurface: 'Mail, calendar and channels',
      userOutcome: 'Triage personal data through reviewed lanes, redacted cards, and confirmed external effects.',
      why: 'The request involves inbox, email, calendar, notes, tasks, reminders, or reply drafting.',
      modelRoute: intakeRoute,
      inspectRoute: laneRoute,
      userRoute: 'Mail, calendar and channels (the menu, Ctrl+G then m)',
      requiresConfirmation: slots.freshRead || slots.changes,
      missingFields: slots.changes ? ['connector lane and record id', 'exact provider effect', 'confirmation'] : undefined,
      supportingRoutes: [
        'personal_ops action:"briefing" includeParameters:true',
        'personal_ops action:"queue" includeParameters:true',
        laneRoute,
        'personal_ops action:"read" laneId:"inbox|calendar" recordId:"..." fields:{...} confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Personal Ops intake is read-only. Provider reads and every send/edit/archive/RSVP effect stay scoped and confirmed.',
    };
  },
};

export const SETUP_ROUTES: readonly TaskRouteEntry[] = [
  setupAndHostReadiness,
  hostRuntimeDiagnostics,
  goodvibesSettingsImport,
  agentSettingsConfiguration,
  localModelSmokeCheck,
  localModelCookbook,
  modelProviderAccount,
  modelRouteReadiness,
  modelProviderRouting,
  personalityAndContext,
  externalMemoryProvider,
  memoryLearning,
  personalOpsConnectorSetup,
  personalOpsDailyBriefing,
  personalOpsReviewQueue,
  personalOpsFreshRead,
  personalOpsIntake,
];
