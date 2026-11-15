/**
 * The client side of the language-server protocol: answering the server's own
 * requests, opening documents before asking about them, and reading the
 * newest diagnostics.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspClient, type LspNotificationRecord } from '../platform/src/platform/intelligence/lsp/client.js';
import { CodeIntelligence, pathToUri } from '../platform/src/platform/intelligence/facade.js';
import type { LspService } from '../platform/src/platform/intelligence/lsp/service.js';

function dispatch(client: LspClient, payload: unknown): void {
  (client as unknown as { _dispatchMessage(body: string): void })._dispatchMessage(JSON.stringify(payload));
}

describe('LspClient server requests', () => {
  test('a request from the server is answered and never resolves a client request with the same id', () => {
    const client = new LspClient('unused', []);
    const written: string[] = [];
    (client as unknown as { proc: unknown }).proc = { stdin: { write: (frame: string) => { written.push(frame); } } };
    let resolved = false;
    (client as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.set(1, {
      resolve: () => { resolved = true; }, reject: () => {}, timer: setTimeout(() => {}, 0),
    });

    dispatch(client, { jsonrpc: '2.0', id: 1, method: 'workspace/configuration', params: { items: [{}, {}] } });

    expect(resolved).toBe(false);
    expect(written).toHaveLength(1);
    const reply = JSON.parse(written[0]!.slice(written[0]!.indexOf('\r\n\r\n') + 4)) as { id: number; result: unknown[] };
    expect(reply.id).toBe(1);
    expect(reply.result).toEqual([null, null]);
    expect(client.takeNotifications(() => true)).toEqual([]);
    clearTimeout((client as unknown as { pendingRequests: Map<number, { timer: ReturnType<typeof setTimeout> }> }).pendingRequests.get(1)!.timer);
  });
});

function fakeLsp() {
  const sent: Array<{ kind: 'notify' | 'request'; method: string }> = [];
  const queued: LspNotificationRecord[] = [];
  const client = {
    notify: (method: string) => { sent.push({ kind: 'notify', method }); },
    request: async (method: string) => { sent.push({ kind: 'request', method }); return null; },
    takeNotifications: (predicate: (n: LspNotificationRecord) => boolean) => queued.filter(predicate),
  };
  const lsp = { getClient: async () => client, isAvailable: async () => true, shutdown: async () => {} } as unknown as LspService;
  return { sent, queued, intelligence: new CodeIntelligence({ lsp }) };
}

describe('CodeIntelligence language server use', () => {
  test('a document is opened before the first request about it, and only once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsp-open-'));
    try {
      const file = join(dir, 'a.ts');
      writeFileSync(file, 'export const a = 1;\n');
      const { sent, intelligence } = fakeLsp();
      await intelligence.getHover(file, 0, 7);
      await intelligence.getHover(file, 0, 7);
      expect(sent.map((entry) => entry.method)).toEqual([
        'textDocument/didOpen', 'textDocument/hover', 'textDocument/hover',
      ]);
      writeFileSync(file, 'export const a = 2;\n');
      await intelligence.getHover(file, 0, 7);
      expect(sent.slice(3).map((entry) => entry.method)).toEqual(['textDocument/didChange', 'textDocument/hover']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the newest published diagnostics for a file win', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsp-diag-'));
    try {
      const file = join(dir, 'a.ts');
      writeFileSync(file, 'let x\n');
      const { queued, intelligence } = fakeLsp();
      const uri = pathToUri(file);
      queued.push(
        { method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ message: 'old' }] }, receivedAt: 1 },
        { method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ message: 'new' }] }, receivedAt: 2 },
      );
      const diagnostics = await intelligence.getDiagnostics(file);
      expect(diagnostics.map((d) => (d as { message: string }).message)).toEqual(['new']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
