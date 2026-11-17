import { fileURLToPath } from 'node:url';
import { assertCurrentToolInvocation, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool, ToolExecuteOptions } from '@goodvibes-jev/engine/platform/platform/types';
import { BrowserSessionError, StaleElementError, UntrustedEffectError } from '@goodvibes-jev/engine/platform/platform/browser';
import type { BrowserActionLifetime, BrowserExtractField, BrowserTarget } from '@goodvibes-jev/engine/platform/platform/browser';
import type { DaemonBrowserGatewayService } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { captureCatalogSnapshotGuard } from './catalog-data.js';
import { toolErrorText } from './tool-error-text.js';
import { readString } from './tool-args.js';

/**
 * The `browser` tool: real browser control through Playwright.
 *
 * It is deliberately NOT an MCP passthrough. Nothing has to be installed,
 * configured, or authorized by hand first, the first call provisions a browser
 * if one is missing and then does the work. Two properties are structural
 * rather than advisory:
 *
 *   - a browser the agent attached to can never be closed by the agent;
 *   - every input action targets an element resolved from a snapshot of a page
 *     this tool controls, so nothing can type into whatever window has focus.
 *
 * The calls run on a browser service: in the Agent's own process, its own
 * engine (runtime/agent-browser.ts); in a session the daemon hosts for the
 * Agent, the daemon's `browser.*` service, so the tool and the verbs drive one
 * browser. An interactive action carries the tool call's admission either way.
 */

/** The browser service the tool's calls run on (the daemon's `browser.*` service, or one over the process's own engine). */
export type BrowserToolBackend = Omit<DaemonBrowserGatewayService, 'shutdown' | 'listSessions'>;

const READ_ONLY_ACTIONS = ['status', 'tabs', 'snapshot', 'read_text'] as const;

const BROWSER_ACTIONS = [
  'status',
  'provision',
  'launch',
  'attach',
  'release',
  'close',
  'navigate',
  'snapshot',
  'click',
  'type',
  'select',
  'press',
  'scroll',
  'wait_for',
  'read_text',
  'screenshot',
  'tabs',
  'new_tab',
  'switch_tab',
  'close_tab',
  'back',
  'forward',
  'extract',
] as const;

export const BROWSER_TOOL_READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(READ_ONLY_ACTIONS);
export const BROWSER_TOOL_ACTIONS: readonly string[] = BROWSER_ACTIONS;

/** Narrows caller input to the fields the extraction contract defines. */
function readExtractFields(value: unknown): readonly BrowserExtractField[] {
  const allowed: readonly BrowserExtractField[] = ['text', 'html', 'value', 'attributes'];
  const requested = readStringArray(value);
  return allowed.filter((field) => requested.includes(field));
}

interface BrowserToolArgs {
  readonly action?: unknown;
  readonly sessionId?: unknown;
  readonly pageId?: unknown;
  readonly url?: unknown;
  readonly ref?: unknown;
  readonly selector?: unknown;
  readonly text?: unknown;
  readonly key?: unknown;
  readonly values?: unknown;
  readonly fields?: unknown;
  readonly all?: unknown;
  readonly cdpEndpoint?: unknown;
  readonly profileName?: unknown;
  readonly headless?: unknown;
  readonly submit?: unknown;
  readonly replace?: unknown;
  readonly fullPage?: unknown;
  readonly path?: unknown;
  readonly direction?: unknown;
  readonly amount?: unknown;
  readonly limit?: unknown;
  readonly maxChars?: unknown;
  readonly timeoutMs?: unknown;
  readonly repair?: unknown;
  readonly button?: unknown;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function readStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function output(payload: Record<string, unknown>): { success: true; output: string } {
  return { success: true, output: JSON.stringify(payload) };
}

function failure(message: string, fix: string | null = null): { success: false; error: string } {
  return { success: false, error: fix ? `${message} ${fix}` : message };
}

/**
 * A `file:` address is a local read, so it is held to the read policy before the
 * browser opens it. Other schemes pass through to the engine's own checks.
 */
async function assertLocalAddressReadable(url: string, readAccess: AgentBrowserToolOptions['readAccess'], signal: AbortSignal | undefined): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return; }
  if (parsed.protocol !== 'file:') return;
  if (!readAccess) {
    throw new BrowserSessionError(
      'The browser tool does not open file: addresses here because no read policy is wired to check them.',
      'Use the read tool for a local file, or open an http or https address.',
    );
  }
  let path: string;
  try { path = fileURLToPath(parsed); } catch {
    throw new BrowserSessionError(`${url} is not a local file address this tool can check.`, 'Use a file:///absolute/path address, or the read tool.');
  }
  if (!(await readAccess(path, signal))) {
    throw new BrowserSessionError(
      `The agent's read policy does not allow opening ${path}.`,
      'Choose a file the read tool is allowed to open, or ask the owner to share its contents.',
    );
  }
}

function requireString(value: unknown, field: string, action: string): string {
  const text = readString(value);
  if (!text) {
    throw new BrowserSessionError(`browser action:"${action}" needs ${field}.`, `Pass ${field}:"…".`);
  }
  return text;
}

export interface AgentBrowserToolOptions {
  /**
   * The browser service, resolved on the first call that needs it: registering
   * the tool must never start a browser or touch the network.
   */
  readonly browser: () => BrowserToolBackend;
  /**
   * Whether the owner's read policy lets this turn open this absolute local
   * path. A `file:` page is read back into the conversation like the read
   * tool's output, so it must pass the same filter. Left absent, `file:`
   * addresses are refused rather than opened unchecked.
   */
  readonly readAccess?: ((absolutePath: string, signal?: AbortSignal) => Promise<boolean>) | undefined;
}

export function createAgentBrowserTool(options: AgentBrowserToolOptions): Tool {
  return {
    definition: {
      name: 'browser',
      activity: { doing: 'Using', did: 'used', object: 'the browser' },
      // Stated, not inferred: readiness surfaces read this from the registry instead of guessing from descriptions.
      capabilities: ['browser-control'],
      description: 'Drive a real browser: open, read, click, type, and sign in.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...BROWSER_ACTIONS],
            description: 'What to do. status reports availability and open sessions.',
          },
          url: { type: 'string', description: 'URL for navigate or new_tab (http, https, file, or about only; file: must be a path the read tool may open), or the address action:"wait_for" waits to reach.' },
          ref: { type: 'string', description: 'Element ref from the latest snapshot of this page.' },
          selector: { type: 'string', description: 'CSS selector for extract. Reaches into open shadow DOM.' },
          text: { type: 'string', description: 'Required for action:"type": the text to enter (an explicit empty string clears the field). For action:"wait_for": the text to wait for; with neither text nor url, wait_for waits for the network to go idle.' },
          key: { type: 'string', description: 'Key name for action:"press", such as Enter or Escape.' },
          values: { type: 'array', items: { type: 'string' }, description: 'Required for action:"select": the option values to choose.' },
          fields: {
            type: 'array',
            items: { type: 'string', enum: ['text', 'html', 'value', 'attributes'] },
            description: 'What to read for action:"extract": any of text, html, value, attributes. Defaults to text; an unknown name is skipped and listed in ignoredFields.',
          },
          all: { type: 'boolean', description: 'For action:"extract": read every match rather than the first.' },
          sessionId: { type: 'string', description: 'Browser session to act on. Defaults to the open session, except action:"release" and action:"close", which require it.' },
          pageId: { type: 'string', description: 'Page/tab to act on. Defaults to the active tab.' },
          cdpEndpoint: { type: 'string', description: 'Remote debugging endpoint of a running browser, for attach.' },
          profileName: { type: 'string', description: 'Saved profile to launch with. Keeps logins across runs.' },
          headless: { type: 'boolean', description: 'Launch with no visible window. Sign-ins need a visible one.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
          replace: { type: 'boolean', description: 'Replace the field contents rather than appending. Default true.' },
          fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of the visible area.' },
          path: { type: 'string', description: 'File name or path inside the screenshot folder to write to. Defaults to a generated name there. An existing file is never overwritten.' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction when no ref is given.' },
          amount: { type: 'number', description: 'Scroll distance in pixels.' },
          limit: { type: 'number', description: 'Maximum elements to include in a snapshot.' },
          maxChars: { type: 'number', description: 'Maximum characters to return from action:"read_text".' },
          timeoutMs: { type: 'number', description: 'Deadline for this one call, in milliseconds (up to 600000). Defaults: navigate, back, forward, new_tab, wait_for and screenshot 30000; click, type, select, press, scroll and read_text 15000. A call that passes its deadline fails and says what to do next. Never affects the browser.' },
          repair: { type: 'boolean', description: 'For provision: reinstall even if a browser is cached.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for action:"click".' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'write_fs', 'state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>, executionOptions?: ToolExecuteOptions) => {
      const inputCurrent = executionOptions ? captureCatalogSnapshotGuard(rawArgs) : undefined;
      const signal = executionOptions?.signal;
      const invocationCurrent = () => {
        inputCurrent?.(rawArgs); signal?.throwIfAborted();
        assertCurrentToolInvocation(rawArgs, executionOptions);
        inputCurrent?.(rawArgs); signal?.throwIfAborted();
      };
      signal?.throwIfAborted();
      const args = rawArgs as BrowserToolArgs;
      const action = readString(args.action).toLowerCase().replace(/-/g, '_');
      const interactiveAction = action === 'click' || action === 'type' || action === 'select' || action === 'press';
      if (executionOptions) invocationCurrent();
      if (!action) {
        return failure(`browser needs an action. Use one of: ${BROWSER_ACTIONS.join(', ')}.`);
      }
      // The call's signal travels with the target, so cancelling the turn ends
      // every page wait this call started, not only the interactive ones.
      const target: BrowserTarget = {
        sessionId: readString(args.sessionId) || undefined,
        pageId: readString(args.pageId) || undefined,
        ...(signal ? { signal } : {}),
      };
      const timeoutMs = readNumber(args.timeoutMs);
      // Launch arguments carried on an ordinary call, so the session opened
      // implicitly by the first navigate matches what was asked for.
      const launch = {
        ...(readString(args.profileName) ? { profileName: readString(args.profileName) } : {}),
        ...(typeof args.headless === 'boolean' ? { headless: args.headless } : {}),
      };
      try {
        const browser = options.browser();
        const assertCurrent = () => { invocationCurrent(); };
        const retained = executionOptions && interactiveAction && browser.retainAdmittedToolAction
          ? await browser.retainAdmittedToolAction(rawArgs, executionOptions, assertCurrent) : undefined;
        const ownership: BrowserActionLifetime | undefined = executionOptions && interactiveAction
          ? retained ?? { signal, assertCurrent } : undefined;
        const interactive = async (run: () => Promise<Record<string, unknown>>) => {
          if (ownership) assertCurrent();
          const result = await run();
          if (ownership) assertCurrent();
          return output(result);
        };
        switch (action) {
          case 'status':
            return output(await browser.status());
          case 'provision':
            // The service answers `{ provision: report }`, the shape this action always returned.
            return output(await browser.provision({ repair: args.repair === true }));
          case 'launch':
            return output(await browser.launch({
              profileName: readString(args.profileName) || undefined,
              ...(typeof args.headless === 'boolean' ? { headless: args.headless } : {}),
            }));
          case 'attach': {
            const cdpEndpoint = readString(args.cdpEndpoint);
            if (!cdpEndpoint) {
              // Naming a missing parameter is honest only if the caller can
              // actually supply it. The owner's regular, already-running
              // browser exposes no remote-debugging port by default, so there
              // is no cdpEndpoint to hand over for it, attach only works for
              // a browser the owner deliberately started with one.
              throw new BrowserSessionError(
                'browser action:"attach" needs cdpEndpoint, and there is no way to get one for the owner\'s regular already-running browser, it exposes no remote-debugging port unless started with one.',
                'Only use attach for a browser the owner deliberately started with --remote-debugging-port=<port> --user-data-dir=<a profile that is not already open>. For anything else, use action:"launch" instead, it opens the agent\'s own managed, isolated profile.',
              );
            }
            return output(await browser.attach({ cdpEndpoint }));
          }
          case 'release':
            return output(await browser.release(requireString(args.sessionId, 'sessionId', 'release')));
          case 'close':
            return output(await browser.close(requireString(args.sessionId, 'sessionId', 'close')));
          case 'navigate': {
            const url = requireString(args.url, 'url', 'navigate');
            await assertLocalAddressReadable(url, options.readAccess, signal);
            return output(await browser.navigate(target, {
              url,
              launch,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }));
          }
          case 'snapshot':
            return output(await browser.snapshot(target, { ...(readNumber(args.limit) === undefined ? {} : { limit: readNumber(args.limit) }) }));
          case 'click':
            return await interactive(() => browser.click(target, {
              ref: requireString(args.ref, 'ref', 'click'),
              ...(args.button === 'right' || args.button === 'middle' || args.button === 'left' ? { button: args.button } : {}),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }, ownership));
          case 'type': {
            // An omitted or misnamed text would otherwise fill the field with
            // nothing, wiping it and reporting success. Clearing is allowed, but
            // only when asked for with an explicit empty string.
            const ref = requireString(args.ref, 'ref', 'type');
            if (typeof args.text !== 'string') {
              throw new BrowserSessionError('browser action:"type" needs text.', 'Pass text:"…" (text:"" clears the field).');
            }
            const text = args.text;
            return await interactive(() => browser.type(target, {
              ref,
              text,
              ...(args.submit === true ? { submit: true } : {}),
              ...(args.replace === false ? { replace: false } : {}),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }, ownership));
          }
          case 'select': {
            const ref = requireString(args.ref, 'ref', 'select');
            const values = readStringArray(args.values);
            if (values.length === 0) throw new BrowserSessionError('browser action:"select" needs values.', 'Pass values:["…"] naming the options to choose.');
            return await interactive(() => browser.select(target, {
              ref,
              values,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }, ownership));
          }
          case 'press':
            return await interactive(() => browser.press(target, {
              ref: requireString(args.ref, 'ref', 'press'),
              key: requireString(args.key, 'key', 'press'),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }, ownership));
          case 'scroll':
            return output(await browser.scroll(target, {
              ...(readString(args.ref) ? { ref: readString(args.ref) } : {}),
              ...(args.direction === 'up' || args.direction === 'down' ? { direction: args.direction } : {}),
              ...(readNumber(args.amount) === undefined ? {} : { amount: readNumber(args.amount) }),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }));
          case 'wait_for':
            return output(await browser.waitFor(target, {
              ...(readString(args.text) ? { text: readString(args.text) } : {}),
              ...(readString(args.url) ? { url: readString(args.url) } : {}),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }));
          case 'read_text':
            return output(await browser.readText(target, {
              ...(readNumber(args.maxChars) === undefined ? {} : { maxChars: readNumber(args.maxChars) }),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }));
          case 'screenshot':
            return output(await browser.screenshot(target, {
              ...(args.fullPage === true ? { fullPage: true } : {}),
              ...(readString(args.path) ? { path: readString(args.path) } : {}),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }));
          case 'tabs':
            return output(await browser.tabs(target));
          case 'new_tab': {
            const url = readString(args.url);
            if (url) await assertLocalAddressReadable(url, options.readAccess, signal);
            return output(await browser.newTab(target, { launch, ...(url ? { url } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) }));
          }
          case 'switch_tab':
            return output(await browser.switchTab(target, { pageId: requireString(args.pageId, 'pageId', 'switch_tab') }));
          case 'close_tab':
            return output(await browser.closeTab(target, { pageId: requireString(args.pageId, 'pageId', 'close_tab') }));
          case 'back':
            return output(await browser.goBack(target, timeoutMs === undefined ? {} : { timeoutMs }));
          case 'forward':
            return output(await browser.goForward(target, timeoutMs === undefined ? {} : { timeoutMs }));
          case 'extract': {
            // A read: an unknown field name is dropped and named in the result rather
            // than costing a refusal and a second call; with none known, text is read.
            const requested = readStringArray(args.fields);
            const fields = readExtractFields(requested);
            const ignoredFields = requested.filter((field) => !(fields as readonly string[]).includes(field));
            const extracted = await browser.extract(target, {
              ...(readString(args.ref) ? { ref: readString(args.ref) } : {}),
              ...(readString(args.selector) ? { selector: readString(args.selector) } : {}),
              ...(fields.length > 0 ? { fields } : {}),
              ...(args.all === true ? { all: true } : {}),
              ...(readNumber(args.limit) === undefined ? {} : { limit: readNumber(args.limit) }),
            });
            return output(ignoredFields.length > 0
              ? { ...extracted, ignoredFields, note: 'Known fields are text, html, value and attributes.' }
              : extracted);
          }
          default:
            return failure(`Unknown browser action: ${action}. Use one of: ${BROWSER_ACTIONS.join(', ')}.`);
        }
      } catch (error) {
        if (signal?.aborted) return failure('The browser action was cancelled.');
        if (error instanceof BrowserSessionError || error instanceof StaleElementError || error instanceof UntrustedEffectError) {
          return failure(error.message, error.fix);
        }
        return failure(toolErrorText(error));
      }
    },
  };
}

export function registerAgentBrowserTool(registry: ToolRegistry, options: AgentBrowserToolOptions): void {
  if (!registry.has('browser')) registry.register(createAgentBrowserTool(options));
}
