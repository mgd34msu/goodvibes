/**
 * Journey 7: the web UI against a real daemon.
 *
 * The built web UI (RUNTHROUGH_WEBUI_DIST, built by run.ts with vite) is
 * served by the daemon itself (controlPlane.webui.serve). A Chromium
 * (RUNTHROUGH_CHROMIUM, default /usr/bin/chromium) driven by the repository's
 * Playwright opens it with a pairing link, so it signs in as a paired device.
 * Every view the journey names is opened and must render without a console
 * error; the actions (a chat turn that uses a tool, answering its approval,
 * saving two settings at once) are made through the calls the web UI makes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Journey, api, approvePending, invoke, nativeTurnStatus, operatorToken, sendNativeHostedTurn, short, stage, waitFor, REPO } from './lib.ts';

const journey = new Journey('j7-webui');
const dist = process.env.RUNTHROUGH_WEBUI_DIST ?? '';
const chromium = process.env.RUNTHROUGH_CHROMIUM ?? '/usr/bin/chromium';
if (!dist || !existsSync(join(dist, 'index.html'))) {
  journey.check('the web UI is built', `RUNTHROUGH_WEBUI_DIST=${dist}`, 'no index.html; run.ts builds it first', false);
  journey.finish(process.env.RUNTHROUGH_DIR ?? '/tmp');
}
const s = await stage('j7', { extraSettings: {} });
s.home.settings('daemon-host', {});
writeFileSync(join(s.home.daemonHome, 'settings.json'), JSON.stringify({
  judgment: { policy: 'No Decision Model' },
  controlPlane: { host: '127.0.0.1', port: s.home.ports.controlPlane, webui: { serve: true, bundleDir: dist } },
  httpListener: { host: '127.0.0.1', port: s.home.ports.http },
  web: { host: '127.0.0.1', port: s.home.ports.web },
}, null, 2));
await s.restartDaemon();

type PageEvent = { type(): string; text(): string; status(): number; url(): string };
type Page = { goto(url: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; title(): Promise<string>; locator(selector: string): { count(): Promise<number>; first(): { innerText(): Promise<string> } }; on(event: string, listener: (value: PageEvent) => void): void; url(): string };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
const { chromium: playwright } = await import(join(REPO, 'products/webui/node_modules/@playwright/test/index.js')) as { chromium: { launch(options: Record<string, unknown>): Promise<Browser> } };

let browser: Browser | undefined;
try {
  const owner = operatorToken(s.home);
  await s.registerWorkspace();
  // Pair the browser as a device, as the pairing QR does.
  const minted = await invoke(s.daemon, owner, 'pairing.tokens.create', { name: 'rt-browser' });
  const device = (minted.body as { token?: { token?: string } }).token?.token ?? '';
  browser = await playwright.launch({ executablePath: chromium, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
  page.on('pageerror', (error) => { errors.push(`pageerror ${String(error)}`); });
  // The console says only "Failed to load resource"; the response names the request.
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await page.goto(`${s.daemon.baseUrl}/#pair=${encodeURIComponent(device)}`);
  await page.waitForTimeout(3_000);
  const title = await page.title();
  const signedIn = !page.url().includes('pair=');
  const bodyText = await page.locator('body').first().innerText();
  journey.check('the built web UI loads from the daemon and signs in with the pairing link', `chromium ${s.daemon.baseUrl}/#pair=<token>`,
    `title ${JSON.stringify(title)}; token dropped from URL ${signedIn}; console errors ${JSON.stringify(errors.slice(0, 3))}; text ${short(bodyText.replace(/\s+/g, ' '), 160)}`,
    minted.status === 200 && signedIn && errors.length === 0 && bodyText.trim().length > 0);

  // A chat turn that uses a tool, its approval answered, as the chat view does (companion chat).
  s.model.scriptWrapped('RTJ7CHAT', [
    { calls: [{ name: 'write', args: { files: [{ path: 'from-webui.txt', content: 'written from the web UI chat\n' }] } }] },
    { text: 'Saved the note.' },
  ]);
  const chat = await api(s.daemon, device, 'POST', '/api/companion/chat/sessions', { title: 'run-through chat' });
  const sessionId = (chat.body as { session?: { id?: string }; id?: string }).session?.id ?? (chat.body as { id?: string }).id ?? '';
  const sent = await api(s.daemon, device, 'POST', `/api/companion/chat/sessions/${encodeURIComponent(sessionId)}/messages`, { content: 'RTJ7CHAT save a note to from-webui.txt', clientMessageId: crypto.randomUUID() });
  const approved: string[] = [];
  const written = await waitFor(async () => {
    for (const approval of await approvePending(s.daemon, device)) approved.push(String((approval.request as { tool?: string } | undefined)?.tool));
    return existsSync(join(s.home.workspace, 'from-webui.txt')) ? true : undefined;
  }, 30_000);
  const replied = await waitFor(async () => {
    const listed = await api(s.daemon, device, 'GET', `/api/companion/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
    return listed.text.includes('Saved the note.') ? listed.text : undefined;
  }, 20_000);
  journey.check('a chat turn that uses a tool runs after its approval is answered', 'companion chat: create a session, send a message (as the chat view); approve each pending approval',
    `session ${chat.status} ${sessionId}; send ${sent.status} ${short(sent.text, 120)}; approvals answered ${JSON.stringify(approved)}; file written ${written === true}; reply listed ${replied !== undefined}`,
    chat.status < 300 && sent.status < 300 && written === true && replied !== undefined);
  void sendNativeHostedTurn; void nativeTurnStatus;

  for (const [label, query] of [
    ['sessions (Work, sessions)', '?view=work&tab=sessions'],
    ['the chat of that session', `?view=chat&session=${encodeURIComponent(sessionId)}`],
    ['the work plan view', '?view=work&tab=plan'],
    ['the owner inbox (Work, all)', '?view=work&tab=all'],
    ['settings', '?settings=models'],
    ['memory copies (Library, memory)', '?view=library&tab=memory'],
  ] as const) {
    const before = errors.length;
    await page.goto(`${s.daemon.baseUrl}/${query}`);
    await page.waitForTimeout(1_500);
    const text = (await page.locator('body').first().innerText()).replace(/\s+/g, ' ');
    journey.check(`the web UI opens ${label} without a console error`, `chromium ${query}`, `errors ${JSON.stringify(errors.slice(before, before + 3))}; text ${short(text, 140)}`,
      errors.length === before && text.trim().length > 0);
  }
  const chatText = await (async () => { await page.goto(`${s.daemon.baseUrl}/?view=chat&session=${encodeURIComponent(sessionId)}`); await page.waitForTimeout(2_000); return (await page.locator('body').first().innerText()).replace(/\s+/g, ' '); })();
  journey.check('the session\'s chat shows the turn and its answer', 'chromium chat view of that session', short(chatText, 300), chatText.includes('Saved the note.'));

  // Two settings saved at once, as the settings dialog's save does.
  const saved = await invoke(s.daemon, device, 'config.setMany', { entries: [{ key: 'display.collapseThreshold', value: 45 }, { key: 'tts.speed', value: 1.25 }] });
  const read = await invoke(s.daemon, device, 'config.get', {});
  journey.check('two settings are saved at once', 'config.setMany { entries: [display.collapseThreshold 45, tts.speed 1.25] }; config.get',
    `set ${saved.status} ${short(saved.text, 200)}; get ${read.status} ${short(read.text, 200)}`,
    saved.status === 200 && read.text.includes('"collapseThreshold":45') && read.text.includes('1.25'));
  void api;
} catch (error) {
  journey.check('journey ran to the end', 'j7', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await browser?.close();
  await s.close();
}
journey.finish(s.base);
