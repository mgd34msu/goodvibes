import { buildSubscriptionEntries as build } from '@goodvibes-jev/engine/terminal-shell/settings-subscriptions';
export * from '@goodvibes-jev/engine/terminal-shell/settings-subscriptions';
export const buildSubscriptionEntries = (manager: Parameters<typeof build>[0], registry: Parameters<typeof build>[1]) => build(manager, registry, { login: provider => `Open Agent Workspace -> Start -> Sign in to a provider for ${provider}.`, finish: provider => `Open Agent Workspace -> Start -> Finish provider sign-in for ${provider}.` });
