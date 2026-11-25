/**
 * The fourteen function groups, in the order a person meets them: one place
 * each in the terminal programs and the web UI, and the same list is the
 * category list a model and an outside agent choose from before they find a
 * capability. `line` is what a person finds there; `about` is the longer
 * description a decision model reads when it picks the group for a need.
 */
export const CAPABILITY_GROUPS = [
  { id: 'conversation', title: 'This conversation', line: 'on the conversation itself: clear, compact, undo, redo, retry, title, checkpoints',
    about: 'What you do to the chat in front of you: clear it, compact it, undo, redo, retry, title, save, fork or branch it, checkpoints and rewind, the context window, queued messages, attaching or pasting, effort and verbosity for this chat.' },
  { id: 'sessions', title: 'Sessions', line: 'your conversations: find, resume, hand off, shared ones',
    about: 'Finding, resuming, searching, deleting or handing off other conversations; sessions shared with or joined from other devices.' },
  { id: 'code', title: 'Code and changes', line: 'changed files, git, worktrees, review, tests, code search',
    about: 'The changed files and diffs, git, worktrees, review, tests, scans, the code index and code intelligence, the editor.' },
  { id: 'work', title: 'Work and agents', line: 'jobs, their plans and results, agents and teams, remote runners',
    about: 'Handing the product a job (work, tasks, to-do lists, plans), agents and teams, contracts, remote runners, comparing or evaluating runs, research runs.' },
  { id: 'waiting', title: 'Waiting for you', line: 'questions, approvals, held items, purchase windows, device requests',
    about: 'Questions, approvals, held items, decisions the product is asking for or has remembered, purchase windows waiting, requests from devices or chat apps to be approved or denied.' },
  { id: 'models', title: 'Models and providers', line: 'models, sign-ins and keys, routing',
    about: 'Choosing a model, pinning, providers and their sign-ins and keys, accounts, routing and fallback, model services.' },
  { id: 'safety', title: 'Permissions and safety', line: 'mode and rules, trust, sandbox, secrets, who is who',
    about: 'The permission mode and remembered rules, security reports, folder trust, policy, the sandbox, secrets (stored passwords and keys), local users and who is who.' },
  { id: 'tools', title: 'Tools and extensions', line: 'MCP servers, plugins, hooks, skills, marketplace',
    about: 'MCP servers and their tools, plugins, hooks, skills, the marketplace, managed settings, presets and bundles.' },
  { id: 'memory', title: 'Memory and knowledge', line: 'memory, notes, knowledge, profile, personas, routines, documents',
    about: 'What the product remembers, notes, the knowledge base and its sources, the owner profile, personas, routines, documents and artifacts, agent homes.' },
  { id: 'messages', title: 'Mail, calendar and channels', line: 'mail, calendars, chat channels, notifications, voice',
    about: 'Mail, calendars and Google, chat channels and delivery, notifications sent out, Telegram, media and voice.' },
  { id: 'automation', title: 'Automation', line: 'schedules, triggers, watches, check-ins',
    about: 'Schedules, triggers and watches, CI watches, check-ins: things that run by themselves at times or on events.' },
  { id: 'devices', title: 'Devices and network', line: 'paired devices, relay, machine groups, secure address, sync',
    about: 'Pairing devices, the relay, machine groups, Cloudflare and tunnels, network scanning, the secure address, settings sync between machines.' },
  { id: 'money', title: 'Money', line: 'cards, purchases, limits, usage and cost',
    about: 'Payment cards, purchases and repeat purchases, spending limits, usage and cost.' },
  { id: 'system', title: 'System', line: 'status, health, updates, setup, settings, help',
    about: 'Status and health, updates, startup and diagnostics, support bundles and moving a setup to another computer, release information, every setting itself (what a setting is set to, change a setting, put a setting back to its default), setup and first run, help, quitting.' },
] as const;

export type CapabilityGroupId = (typeof CAPABILITY_GROUPS)[number]['id'];

export const CAPABILITY_GROUP_IDS: readonly CapabilityGroupId[] = CAPABILITY_GROUPS.map((group) => group.id);

export function isCapabilityGroupId(value: unknown): value is CapabilityGroupId {
  return typeof value === 'string' && (CAPABILITY_GROUP_IDS as readonly string[]).includes(value);
}

export function capabilityGroup(id: CapabilityGroupId): (typeof CAPABILITY_GROUPS)[number] {
  return CAPABILITY_GROUPS.find((group) => group.id === id)!;
}

/**
 * The groups in one short paragraph for a model's prompt (the part every
 * request repeats, so it is cached): what each holds, and how to reach it.
 */
export const CAPABILITY_GROUPS_PROMPT = [
  'GoodVibes\' own capabilities (settings, secrets, hooks, memory, schedules, mail, devices and the rest of what a person can do in its screens) are reached with two tools: capability_find says what you need in words and returns a few capabilities with their inputs and risk; capability_run runs one by id with its inputs, through the same permission gate as every other call. A capability found once stays callable for this session. Groups:',
  ...CAPABILITY_GROUPS.map((group) => `- ${group.title}: ${group.line}`),
].join('\n');
