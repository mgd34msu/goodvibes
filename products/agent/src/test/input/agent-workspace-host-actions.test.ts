import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { DaemonConfigClient } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { installAgentDaemonConfigClient } from '../../config/daemon-config-routing.ts';
import { installAgentDaemonCredentialsClient } from '../../config/daemon-credential-routing.ts';
import { createCalendarOAuthEditor } from '../../input/agent-workspace-calendar-oauth-editor.ts';
import { trySubmitDirectHostActionEditor } from '../../input/agent-workspace-direct-editor-submission.ts';
import { EmailService } from '@goodvibes-jev/engine/platform/platform/email';
import { createEmailConnectWizardEditor, submitAgentWorkspaceEmailConnectWizardEditor } from '../../input/agent-workspace-email-connect-editor.ts';
import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor, AgentWorkspaceRuntimeSnapshot } from '../../input/agent-workspace-types.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

interface Host {
  localEditor: AgentWorkspaceLocalEditor | null;
  runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
  clampSelection(): void;
}

function host(): Host {
  return { localEditor: null, runtimeSnapshot: null, status: '', lastActionResult: null, clampSelection: () => {} };
}

const secrets = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
};

function contextAt(root: string): { ctx: CommandContext; cm: ConfigManager } {
  const cm = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'global-tui') });
  const ctx = {
    session: {} as never,
    provider: {} as never,
    workspace: {} as never,
    platform: { config: {} as never, configManager: cm, secretsManager: secrets } as never,
    ops: {} as never,
    extensions: {} as never,
    clients: {} as never,
    renderRequest: () => {},
    print: () => {},
    exit: () => {},
  } as CommandContext;
  return { ctx, cm };
}

afterEach(() => {
  installAgentDaemonConfigClient(null);
  installAgentDaemonCredentialsClient(null);
});

function reader(values: Record<string, string>): (id: string) => string {
  return (id) => values[id] ?? '';
}

describe('calendar credentials on a connected host', () => {
  /** A connected host that owns calendar.* keys and holds each write until released. */
  function gatedHost() {
    const writes: { key: string; value: unknown }[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client: DaemonConfigClient = {
      ownsKey: (key) => key.startsWith('calendar.'),
      set: async (key, value) => {
        writes.push({ key, value });
        await gate;
      },
      get: async () => undefined,
      snapshot: async () => null,
    };
    return { writes, release, client };
  }

  test('the client id is written to the connected host, not only to the local config', async () => {
    const { ctx, cm } = contextAt(makeProjectTempDir('host-actions-oauth'));
    const connected = gatedHost();
    connected.release();
    installAgentDaemonConfigClient(connected.client);
    const h = host();
    const settled = new Promise<void>((resolve) => {
      trySubmitDirectHostActionEditor(h, createCalendarOAuthEditor('google'), ctx, reader({ clientId: 'client-1', confirm: 'yes' }), resolve);
    });
    await settled;
    expect(connected.writes).toEqual([{ key: 'calendar.google.clientId', value: 'client-1' }]);
    expect(cm.get('calendar.google.clientId' as never)).not.toBe('client-1');
  });

  test('a second Enter while the first submit is running does not start another', async () => {
    const { ctx } = contextAt(makeProjectTempDir('host-actions-inflight'));
    const connected = gatedHost();
    installAgentDaemonConfigClient(connected.client);
    const h = host();
    const editor = createCalendarOAuthEditor('google');
    const fields = reader({ clientId: 'client-1', confirm: 'yes' });
    const first = new Promise<void>((resolve) => {
      trySubmitDirectHostActionEditor(h, editor, ctx, fields, resolve);
    });
    let secondRenders = 0;
    trySubmitDirectHostActionEditor(h, editor, ctx, fields, () => { secondRenders += 1; });
    expect(h.status).toContain('still running');
    expect(secondRenders).toBe(1);
    connected.release();
    await first;
    expect(connected.writes).toHaveLength(1);
    expect(h.lastActionResult?.kind).toBe('refreshed');
    // The guard is released afterwards: a later submit runs again.
    const again = new Promise<void>((resolve) => {
      trySubmitDirectHostActionEditor(h, editor, ctx, fields, resolve);
    });
    expect(h.status).not.toContain('Still working');
    await again;
    expect(connected.writes).toHaveLength(2);
  });
});

describe('inbox connect form', () => {
  const VALID: Record<string, string> = {
    imapHost: 'imap.example.test',
    imapPort: '993',
    smtpHost: 'smtp.example.test',
    smtpPort: '587',
    smtpSecure: 'false',
    username: 'user@example.test',
    password: 'mailbox-password',
    fromAddress: 'user@example.test',
    confirm: 'yes',
  };

  test('a failed connection test keeps the form open with the typed values', async () => {
    const { ctx } = contextAt(makeProjectTempDir('host-actions-email-a'));
    const h = host();
    const editor = createEmailConnectWizardEditor(null);
    await submitAgentWorkspaceEmailConnectWizardEditor(h, editor, ctx, reader(VALID), () => ({
      testConnection: async () => ({ ok: false, stage: 'imap', error: 'Invalid credentials' }),
    }));
    expect(h.localEditor).not.toBeNull();
    expect(h.localEditor?.message).toContain('imap');
    expect(h.localEditor?.message).toContain('Invalid credentials');
    expect(h.lastActionResult?.kind).toBe('error');
  });

  test('an invalid later field leaves the earlier fields as they were', async () => {
    const { ctx, cm } = contextAt(makeProjectTempDir('host-actions-email-b'));
    const h = host();
    const editor = createEmailConnectWizardEditor(null);
    // Prime the defaults so the "before" value is what a real config holds.
    await submitAgentWorkspaceEmailConnectWizardEditor(h, editor, ctx, reader({ ...VALID, confirm: 'no' }));
    const before = cm.get('surfaces.email.imap.host');
    await submitAgentWorkspaceEmailConnectWizardEditor(h, editor, ctx, reader({ ...VALID, smtpPort: '0' }));
    expect(h.lastActionResult?.kind).toBe('error');
    expect(h.localEditor).not.toBeNull();
    expect(cm.get('surfaces.email.imap.host')).toBe(before);
    expect(cm.get('surfaces.email.imap.host')).not.toBe('imap.example.test');
  });

  test('the non-secret settings are written to a connected host that owns the email keys', async () => {
    const { ctx, cm } = contextAt(makeProjectTempDir('host-actions-email-routed'));
    const writes: { key: string; value: unknown }[] = [];
    installAgentDaemonConfigClient({
      ownsKey: (key) => key.startsWith('surfaces.email.'),
      set: async (key, value) => { writes.push({ key, value }); },
      get: async () => undefined,
      snapshot: async () => null,
    });
    const h = host();
    await submitAgentWorkspaceEmailConnectWizardEditor(h, createEmailConnectWizardEditor(null), ctx, reader({ ...VALID, confirm: 'no' }));
    const before = cm.get('surfaces.email.imap.host');
    await submitAgentWorkspaceEmailConnectWizardEditor(h, createEmailConnectWizardEditor(null), ctx, reader(VALID), () => ({
      testConnection: async () => ({ ok: true }),
    }));
    expect(writes.filter((w) => w.key === 'surfaces.email.imap.host')).toEqual([{ key: 'surfaces.email.imap.host', value: 'imap.example.test' }]);
    expect(writes.some((w) => w.key === 'surfaces.email.user' && w.value === 'user@example.test')).toBe(true);
    expect(cm.get('surfaces.email.imap.host')).toBe(before);
  });

  test('on a connected host the wizard saves the mailbox on the host without a local password check', async () => {
    const { ctx, cm } = contextAt(makeProjectTempDir('host-actions-email-verify'));
    const hostConfig: Record<string, unknown> = {};
    const setNested = (key: string, value: unknown) => {
      const parts = key.split('.');
      let cursor = hostConfig;
      for (const part of parts.slice(0, -1)) cursor = (cursor[part] ??= {}) as Record<string, unknown>;
      cursor[parts[parts.length - 1]!] = value;
    };
    const writes: string[] = [];
    installAgentDaemonConfigClient({
      ownsKey: (key) => key.startsWith('surfaces.email.'),
      set: async (key, value) => { writes.push(key); setNested(key, value); },
      get: async () => undefined,
      snapshot: async () => hostConfig,
    });
    // The host stores the mailbox password and its reference itself.
    installAgentDaemonCredentialsClient({
      set: async (key: string) => { setNested(key, 'goodvibes://secrets/goodvibes/email-password'); },
      clear: async () => {},
    } as never);
    // The local secret store does NOT hold the password: only the host does.
    (ctx.platform as unknown as { secretsManager: unknown }).secretsManager = { ...secrets, get: async () => null };
    const h = host();
    let tested = false;
    await submitAgentWorkspaceEmailConnectWizardEditor(h, createEmailConnectWizardEditor(null), ctx, reader(VALID), () => {
      tested = true;
      return { testConnection: async () => ({ ok: false, stage: 'config', error: 'no secret by that name was found' }) };
    });
    // No local verification that could never pass: saved on the host, with the skipped check stated.
    expect(tested).toBe(false);
    expect(h.localEditor).toBeNull();
    expect(h.lastActionResult?.kind).toBe('refreshed');
    expect(h.lastActionResult?.detail).toContain('not verified');
    expect(writes).toContain('surfaces.email.imap.host');
    expect(cm.get('surfaces.email.imap.host')).not.toBe('imap.example.test');
  });

  test('a password that cannot be stored says what was stored and leaves the settings as they were', async () => {
    const { ctx, cm } = contextAt(makeProjectTempDir('host-actions-email-throw'));
    const h = host();
    await submitAgentWorkspaceEmailConnectWizardEditor(h, createEmailConnectWizardEditor(null), ctx, reader({ ...VALID, confirm: 'no' }));
    const before = cm.get('surfaces.email.imap.host');
    (ctx.platform as unknown as { secretsManager: unknown }).secretsManager = {
      ...secrets,
      set: async () => { throw new Error('secret store unavailable'); },
    };
    await submitAgentWorkspaceEmailConnectWizardEditor(h, createEmailConnectWizardEditor(null), ctx, reader(VALID), () => ({
      testConnection: async () => ({ ok: true }),
    }));
    expect(h.lastActionResult?.kind).toBe('error');
    expect(h.status).toContain('secret store unavailable');
    expect(cm.get('surfaces.email.imap.host')).toBe(before);
    expect(cm.get('surfaces.email.imap.host')).not.toBe('imap.example.test');
  });
});
