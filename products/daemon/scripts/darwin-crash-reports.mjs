// Reads the crash reports macOS writes when a daemon process dies by a signal,
// so a failed native step says where the program stopped instead of only that
// it did. macOS writes one .ips file per crash under the user's
// ~/Library/Logs/DiagnosticReports (and the system's /Library/Logs/...); the
// first line is a JSON header, the rest one JSON body with the exception, the
// termination reason, application-specific messages and every thread's frames.
//
//   node darwin-crash-reports.mjs [--since <ISO time>] [--copy-to <dir>]
//
// prints every goodvibes-daemon report (since the given time) and copies the
// files to <dir> for upload. It always exits 0: it explains a failure that a
// step before it already reported, it never decides one.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORT_PREFIX = 'goodvibes-daemon';
const TRIGGERED_FRAMES = 40;
const OTHER_FRAMES = 3;

export function darwinCrashReportDirectories() {
  // The real account home, not $HOME: the verifier runs the daemon with a temporary one.
  return [join(userInfo().homedir, 'Library/Logs/DiagnosticReports'), '/Library/Logs/DiagnosticReports'];
}

/** Paths of the daemon's crash reports written at or after `since` (ms since epoch), newest last. */
export function findDarwinCrashReports({ since = 0, prefix = REPORT_PREFIX } = {}) {
  const found = [];
  for (const directory of darwinCrashReportDirectories()) {
    let names;
    try { names = readdirSync(directory); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(prefix) || !(name.endsWith('.ips') || name.endsWith('.crash'))) continue;
      const path = join(directory, name);
      try { const stat = statSync(path); if (stat.isFile() && stat.mtimeMs >= since) found.push({ path, mtimeMs: stat.mtimeMs }); }
      catch { /* removed while listing */ }
    }
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs).map(entry => entry.path);
}

function parseIps(text) {
  const newline = text.indexOf('\n');
  if (newline < 0) return { header: JSON.parse(text), body: {} };
  return { header: JSON.parse(text.slice(0, newline)), body: JSON.parse(text.slice(newline + 1)) };
}

function frameText(frame, images) {
  const image = images[frame.imageIndex]?.name ?? `image ${frame.imageIndex}`;
  if (frame.symbol) return `${image}  ${frame.symbol} + ${frame.symbolLocation ?? 0}`;
  return `${image} + 0x${Number(frame.imageOffset ?? 0).toString(16)}`;
}

/** The pid a report belongs to, or undefined when it cannot be read. */
export function darwinCrashReportPid(path) {
  try { return parseIps(readFileSync(path, 'utf8')).body.pid; } catch { return undefined; }
}

/** A readable summary of one report: what stopped the program, where, and on which thread. */
export function describeDarwinCrashReport(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) { return `${path}: could not be read (${error.message})`; }
  if (path.endsWith('.crash')) return `${path}\n${text.slice(0, 16_384)}`;
  let header, body;
  try { ({ header, body } = parseIps(text)); }
  catch { return `${path}: not a JSON crash report; first lines:\n${text.slice(0, 4_096)}`; }
  const images = Array.isArray(body.usedImages) ? body.usedImages : [];
  const lines = [`${path}`,
    `  process: ${body.procName ?? header.name ?? '?'} pid ${body.pid ?? '?'} (${body.cpuType ?? '?'}), parent ${body.parentProc ?? '?'} ${body.parentPid ?? ''}`.trimEnd(),
    `  os: ${header.os_version ?? '?'}; captured ${body.captureTime ?? header.timestamp ?? '?'}`];
  if (body.exception) lines.push(`  exception: ${body.exception.type ?? '?'} (${body.exception.signal ?? '?'}) codes ${body.exception.codes ?? '?'}${body.exception.subtype ? `; ${body.exception.subtype}` : ''}`);
  if (body.termination) lines.push(`  termination: ${body.termination.indicator ?? ''} [${body.termination.namespace ?? '?'} ${body.termination.code ?? '?'}] by ${body.termination.byProc ?? '?'}`);
  if (body.asi) for (const [image, messages] of Object.entries(body.asi)) lines.push(`  message from ${image}: ${[].concat(messages).join(' | ')}`);
  if (body.ktriageinfo) lines.push(`  kernel triage: ${String(body.ktriageinfo).trim()}`);
  const threads = Array.isArray(body.threads) ? body.threads : [];
  const faulting = Number.isInteger(body.faultingThread) ? body.faultingThread : threads.findIndex(thread => thread.triggered);
  threads.forEach((thread, index) => {
    const triggered = index === faulting || thread.triggered === true;
    const frames = Array.isArray(thread.frames) ? thread.frames : [];
    lines.push(`  thread ${index}${triggered ? ' (crashed)' : ''}: ${thread.name ?? ''}${thread.queue ? ` [${thread.queue}]` : ''}`);
    for (const frame of frames.slice(0, triggered ? TRIGGERED_FRAMES : OTHER_FRAMES)) lines.push(`    ${frameText(frame, images)}`);
    if (triggered && thread.threadState?.esr) lines.push(`    esr: ${JSON.stringify(thread.threadState.esr)}`);
  });
  const main = images[0];
  if (main) lines.push(`  program image: ${main.name ?? '?'} uuid ${main.uuid ?? '?'} at ${main.path ?? '?'}`);
  return lines.join('\n');
}

/**
 * Called only once a child is already known to have died by a signal: macOS
 * writes the report a moment after the process is gone, so look for the one
 * of this pid for up to `waitMs`. Returns the summaries found, possibly none.
 */
export async function darwinCrashReportsFor({ pid, since, waitMs = 10_000 }) {
  if (process.platform !== 'darwin') return [];
  const deadline = Date.now() + waitMs;
  for (;;) {
    const reports = findDarwinCrashReports({ since: since - 1_000 });
    const own = reports.filter(path => darwinCrashReportPid(path) === pid);
    if (own.length > 0 || Date.now() >= deadline) return (own.length > 0 ? own : reports).map(describeDarwinCrashReport);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function tail(text, limit = 65_536) {
  return text.length <= limit ? text : `[first ${text.length - limit} characters left out]\n${text.slice(-limit)}`;
}

/**
 * Print what a native child left behind when it ended other than as expected:
 * its own output, and on macOS the crash report of that pid. Never throws.
 */
export async function reportNativeChildEnd({ label, pid, since, result, stdout = '', stderr = '' }) {
  try {
    const lines = [`${label} (pid ${pid ?? '?'}) ended with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`}.`,
      `--- its standard error ---`, tail(stderr) || '(empty)', `--- its standard output ---`, tail(stdout) || '(empty)'];
    if (result.signal && pid !== undefined) {
      const reports = await darwinCrashReportsFor({ pid, since });
      lines.push(`--- crash reports ---`, ...(reports.length > 0 ? reports : ['(macOS wrote no goodvibes-daemon crash report in time)']));
    }
    console.error(lines.join('\n'));
  } catch (error) { console.error(`${label}: its end could not be described (${error?.message ?? error})`); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const sinceText = option('--since'), copyTo = option('--copy-to');
  const since = sinceText ? Date.parse(sinceText) : 0;
  if (Number.isNaN(since)) { console.error(`--since is not a time: ${sinceText}`); process.exit(0); }
  const reports = findDarwinCrashReports({ since });
  if (reports.length === 0) console.log(`No ${REPORT_PREFIX} crash report in ${darwinCrashReportDirectories().join(' or ')}.`);
  for (const path of reports) {
    console.log(describeDarwinCrashReport(path));
    if (copyTo) {
      try { mkdirSync(copyTo, { recursive: true }); copyFileSync(path, join(copyTo, basename(path))); }
      catch (error) { console.log(`  (not copied: ${error.message})`); }
    }
  }
}
