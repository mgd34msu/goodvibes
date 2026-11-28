/**
 * GENERATED FILE. DO NOT EDIT BY HAND.
 * Produced by scripts/generate-config-ownership.ts from the installed
 * @goodvibes/engine: DAEMON_OWNED_CONFIG_PREFIXES, DAEMON_OWNED_CONFIG_KEYS
 * and DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS (platform/config).
 *
 * This is a build-time snapshot so the browser bundle never imports the engine
 * config barrel (which drags SecretsManager / OAuth / google-auth, node-only).
 *
 * Regenerate: `bun run config-ownership:generate`.
 * `bun run generated:check` verifies it before every build.
 */

export const DAEMON_OWNED_CONFIG_PREFIXES: readonly string[] = [
  "surfaces.",
  "controlPlane.",
  "httpListener.",
  "web.",
  "secureAddress.",
  "relay.",
  "watchers.",
  "device.",
  "automation.",
  "checkin.",
  "integrations.",
  "atRest.",
  "payments.",
  "conversationGate.",
  "hostedSessions.",
  "cluster.",
  "profile.",
  "occasions.",
  "calendar.",
  "google.",
  "judgment.",
  "push.",
  "cloudflare.",
  "worktree.",
  "service.",
  "voice.local.",
  "storage.secretProviders."
] as const;

export const DAEMON_OWNED_CONFIG_KEYS: readonly string[] = [
  "danger.httpListener",
  "daemon.timezone",
  "network.privateDeliveryHosts",
  "update.auto",
  "update.autoUpdateAtLaunch",
  "power.keepAwake",
  "provider.model",
  "provider.reasoningEffort",
  "provider.fallbackModels",
  "provider.optimizerMode",
  "provider.optimizerPinnedModel",
  "permissions.mode",
  "behavior.budgetAlertUsd",
  "notifications.webhookUrls",
  "sandbox.mcpIsolation",
  "sandbox.enabled",
  "pricing.modelPrices",
  "storage.codeIndexEnabled",
  "storage.automaticProjectsFolder"
] as const;

export const DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS: readonly string[] = [
  "cluster.groupMaterial",
  "google.oauth.refreshToken",
  "google.oauth.account",
  "email.passwordRef",
  "email.smtpPasswordRef"
] as const;
