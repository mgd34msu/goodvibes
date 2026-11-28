/**
 * The screens drawn from slash command descriptions, by name: what the palette
 * lists and the composer's slash menu offers. The screens themselves load when
 * one opens (CommandScreens.tsx).
 */
export interface CommandScreenListing {
  readonly id: string;
  /** The palette row and the panel's name. */
  readonly title: string;
  /** The slash command it is drawn from (searchable in the palette as `/name`). */
  readonly command: string;
  readonly keywords: readonly string[];
  /** The place that is this screen (views/places): opening it opens the place, the group's one web view. */
  readonly place?: string;
}

export const COMMAND_SCREEN_LIST: readonly CommandScreenListing[] = [
  { id: 'automation', title: 'Automation', command: 'schedule', keywords: ['automation', 'schedule', 'schedules', 'routine', 'cron', 'every', 'remind', 'runs', 'triggers', 'watch', 'watcher', 'grant', 'fires', 'ci', 'checks', 'check-in', 'checkin'], place: 'automation' },
  { id: 'tools', title: 'Tools and extensions', command: 'mcp', keywords: ['tools', 'extensions', 'mcp', 'servers', 'block', 'trust', 'role', 'hooks', 'hook', 'trace', 'ran', 'plugins', 'skills', 'presets', 'managed', 'marketplace'], place: 'tools' },
  { id: 'money', title: 'Money', command: 'payments', keywords: ['money', 'cards', 'card', 'payments', 'address', 'shipping', 'billing', 'purchase', 'approve', 'spending', 'cost', 'usage'], place: 'money' },
  { id: 'repeat-purchases', title: 'Repeat purchases', command: 'repeat-purchases', keywords: ['payments', 'standing', 'repeat', 'purchase', 'buy', 'allowance'] },
  { id: 'system', title: 'System', command: 'status', keywords: ['system', 'sleep', 'awake', 'power', 'update', 'voice', 'sign-in', 'first-run'], place: 'system' },
  { id: 'devices', title: 'Devices and network', command: 'devices', keywords: ['devices', 'paired', 'pairing', 'phone', 'relay', 'grants', 'captures', 'group', 'cluster', 'machines', 'cloudflare', 'network'], place: 'devices' },
  { id: 'waiting', title: 'Waiting for you', command: 'waiting', keywords: ['waiting', 'questions', 'approvals', 'answer', 'held', 'calls', 'decisions', 'decided', 'jev', 'telegram', 'messages', 'review', 'inbox', 'kinds'], place: 'waiting' },
  { id: 'safety', title: 'Permissions and safety', command: 'permissions', keywords: ['permissions', 'rules', 'allow', 'deny', 'never', 'secrets', 'keys', 'password', 'sign-in', 'users', 'principals', 'people', 'tokens', 'grants', 'security', 'trust'], place: 'safety' },
  { id: 'code', title: 'Code and changes', command: 'changes', keywords: ['code', 'changes', 'worktree', 'worktrees', 'setup', 'remove', 'branch', 'git'], place: 'code' },
];
