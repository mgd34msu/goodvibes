import { randomUUID } from 'node:crypto';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { formatJsonStoreWriteReport, readJsonStore, updateJsonStore, type JsonStoreSpec } from './store-file.js';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import type { AgentChannelDeliveryInput, AgentChannelDeliveryResult } from './channel-delivery.js';

export type AgentChannelDeliveryReceiptSource = 'command' | 'model-tool';
export type AgentChannelDeliveryReceiptStatus = 'sent';

export interface AgentChannelDeliveryReceiptTarget {
  readonly kind: string;
  readonly display: string;
  readonly surfaceKind?: string | undefined;
  readonly routeId?: string | undefined;
  readonly label?: string | undefined;
  readonly addressHost?: string | undefined;
  readonly addressScheme?: string | undefined;
  readonly redactedAddress?: boolean | undefined;
}

export interface AgentChannelDeliveryReceipt {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly source: AgentChannelDeliveryReceiptSource;
  readonly status: AgentChannelDeliveryReceiptStatus;
  readonly title: string;
  readonly target: AgentChannelDeliveryReceiptTarget;
  readonly messagePreview: string;
  readonly messageLength: number;
  readonly strategyCount: number;
  readonly responseId?: string | undefined;
  readonly authorization: 'explicit-user-confirmed';
  readonly userRoute: string;
  readonly modelRoute: string;
}

export interface AgentChannelDeliveryReceiptSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly receipts: readonly AgentChannelDeliveryReceipt[];
  readonly parseError?: string | undefined;
}

type AgentChannelDeliveryReceiptShellPaths = Pick<ShellPathService, 'resolveUserPath'>;

const RECEIPT_VERSION = 1;
const RECEIPT_LIMIT = 100;
const MESSAGE_PREVIEW_LIMIT = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function redactSecretLikeText(value: string): string {
  return value
    .replace(/\bhttps?:\/\/\S+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}/...`;
      } catch {
        return '[redacted-url]';
      }
    })
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[redacted-token]')
    .replace(/\b([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '[redacted-token]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}

function previewMessage(message: string): string {
  const safe = redactSecretLikeText(normalizeWhitespace(message));
  return safe.length > MESSAGE_PREVIEW_LIMIT ? `${safe.slice(0, MESSAGE_PREVIEW_LIMIT - 1)}...` : safe;
}

function safeRouteArg(value: string): string {
  return normalizeWhitespace(value).replace(/"/g, '\\"');
}

function summarizeAddress(address: string | undefined, kind: string): AgentChannelDeliveryReceiptTarget {
  const normalized = readString(address);
  if (!normalized) return { kind, display: kind, redactedAddress: true };
  try {
    const url = new URL(normalized);
    return {
      kind,
      display: `${kind} ${url.protocol}//${url.host}/...`,
      addressHost: url.host,
      addressScheme: url.protocol.replace(/:$/, ''),
      redactedAddress: true,
    };
  } catch {
    return {
      kind,
      display: `${kind} [redacted-target]`,
      redactedAddress: true,
    };
  }
}

function summarizeTarget(result: AgentChannelDeliveryResult): AgentChannelDeliveryReceiptTarget {
  const target = result.target;
  if (target.kind === 'surface') {
    const surfaceKind = readString(target.surfaceKind) || 'route';
    const details = [
      target.routeId ? `route ${target.routeId}` : '',
      target.label ? `label ${target.label}` : '',
    ].filter(Boolean);
    return {
      kind: 'surface',
      display: `${surfaceKind}${details.length > 0 ? ` (${details.join(', ')})` : ''}`,
      surfaceKind,
      ...(target.routeId ? { routeId: target.routeId } : {}),
      ...(target.label ? { label: target.label } : {}),
    };
  }
  return summarizeAddress(target.address, target.kind);
}

function targetInput(input: AgentChannelDeliveryInput): string {
  if (input.channel) return `--channel "${safeRouteArg(input.channel)}"`;
  if (input.route) return `--route "${safeRouteArg(input.route)}"`;
  if (input.webhook) return '--webhook "[redacted-webhook]"';
  if (input.link) return '--link "[redacted-link]"';
  return '--channel "<target>"';
}

function parseTarget(value: unknown): AgentChannelDeliveryReceiptTarget | null {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  const display = readString(value.display);
  if (!kind || !display) return null;
  const surfaceKind = readString(value.surfaceKind);
  const routeId = readString(value.routeId);
  const label = readString(value.label);
  const addressHost = readString(value.addressHost);
  const addressScheme = readString(value.addressScheme);
  return {
    kind,
    display,
    ...(surfaceKind ? { surfaceKind } : {}),
    ...(routeId ? { routeId } : {}),
    ...(label ? { label } : {}),
    ...(addressHost ? { addressHost } : {}),
    ...(addressScheme ? { addressScheme } : {}),
    ...(value.redactedAddress === true ? { redactedAddress: true } : {}),
  };
}

function parseReceipt(value: unknown): AgentChannelDeliveryReceipt | null {
  if (!isRecord(value) || value.version !== RECEIPT_VERSION) return null;
  const id = readString(value.id);
  const createdAt = readString(value.createdAt);
  const source = value.source === 'model-tool' ? 'model-tool' : value.source === 'command' ? 'command' : null;
  const status = value.status === 'sent' ? 'sent' : null;
  const title = readString(value.title);
  const target = parseTarget(value.target);
  const messagePreview = readString(value.messagePreview);
  const messageLength = readNumber(value.messageLength);
  const strategyCount = readNumber(value.strategyCount);
  const userRoute = readString(value.userRoute);
  const modelRoute = readString(value.modelRoute);
  if (!id || !createdAt || Number.isNaN(Date.parse(createdAt)) || !source || !status || !title || !target || messageLength === null || strategyCount === null || !userRoute || !modelRoute) {
    return null;
  }
  const responseId = readString(value.responseId);
  return {
    version: RECEIPT_VERSION,
    id,
    createdAt,
    source,
    status,
    title,
    target,
    messagePreview,
    messageLength,
    strategyCount,
    ...(responseId ? { responseId } : {}),
    authorization: 'explicit-user-confirmed',
    userRoute,
    modelRoute,
  };
}

const RECEIPT_STORE: JsonStoreSpec<AgentChannelDeliveryReceipt> = {
  label: 'channel delivery receipts',
  entriesKey: 'receipts',
  version: RECEIPT_VERSION,
  parseEntry: parseReceipt,
};

export function agentChannelDeliveryReceiptPath(shellPaths: AgentChannelDeliveryReceiptShellPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'channels', 'delivery-receipts.json');
}

export function readAgentChannelDeliveryReceipts(shellPaths: AgentChannelDeliveryReceiptShellPaths): AgentChannelDeliveryReceiptSnapshot {
  const path = agentChannelDeliveryReceiptPath(shellPaths);
  const store = readJsonStore(path, RECEIPT_STORE);
  return {
    path,
    exists: store.exists,
    receipts: store.entries,
    ...(store.unreadable === undefined ? {} : { parseError: store.unreadable }),
  };
}

export function recordAgentChannelDeliveryReceipt(
  shellPaths: AgentChannelDeliveryReceiptShellPaths,
  input: {
    readonly source: AgentChannelDeliveryReceiptSource;
    readonly deliveryInput: AgentChannelDeliveryInput;
    readonly result: AgentChannelDeliveryResult;
  },
): AgentChannelDeliveryReceipt & { readonly storeNote?: string | undefined } {
  const path = agentChannelDeliveryReceiptPath(shellPaths);
  const title = previewMessage(input.result.title || 'GoodVibes Agent message');
  const receipt: AgentChannelDeliveryReceipt = {
    version: RECEIPT_VERSION,
    id: `channel-delivery-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    source: input.source,
    status: 'sent',
    title,
    target: summarizeTarget(input.result),
    messagePreview: previewMessage(input.result.message),
    messageLength: input.result.message.length,
    strategyCount: input.result.strategyCount,
    ...(input.result.responseId ? { responseId: input.result.responseId } : {}),
    authorization: 'explicit-user-confirmed',
    userRoute: `/channels send --title "${safeRouteArg(title)}" ${targetInput(input.deliveryInput)} --message "[redacted]" --yes`,
    modelRoute: 'agent_channel_send explicitUserRequest:"..."',
  };
  // Under the store's lock like every other store, so a CLI send and a running Agent's send both keep their receipt.
  const { write } = updateJsonStore(path, RECEIPT_STORE, (store) => ({
    value: undefined,
    entries: [receipt, ...store.entries].slice(0, RECEIPT_LIMIT),
  }));
  const storeNote = formatJsonStoreWriteReport(write, 'delivery receipt');
  return storeNote ? { ...receipt, storeNote } : receipt;
}

export function formatAgentChannelDeliveryReceiptLine(receipt: AgentChannelDeliveryReceipt): string {
  return [
    `${receipt.createdAt} ${receipt.id}`,
    receipt.status,
    receipt.source,
    `target=${receipt.target.display}`,
    `title=${receipt.title}`,
    receipt.responseId ? `response=${receipt.responseId}` : '',
    `message=${receipt.messageLength} chars`,
    receipt.messagePreview ? `preview="${receipt.messagePreview}"` : '',
  ].filter(Boolean).join(' ');
}
