/**
 * bundle-file-work.ts: the support bundle, the support folder and the moved setup, when this program's daemon runs on
 * another machine.
 *
 * The daemon builds and reads them (capabilities/builtin/system-bundles.ts); the file a person names is on the machine
 * of the program they typed or pressed in. With a daemon on this machine the daemon reads and writes it there itself.
 * With one on another machine this program does the file work on its own disk: it reads the file (a folder: its files)
 * and sends what it holds (`content`, with `filesAt: program`), and writes what comes back (`data.file`, `data.files`),
 * after checking what is already at that place exactly as the daemon would. One wrapper for every door this program
 * has: its places and typed lines (the capability binding's caller) and its command-line forms (`do`, `bundle`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { DaemonVerbCaller } from '@goodvibes/engine/platform/platform/runtime/client';
import type { CapabilityCliInvoke } from './capability-cli.js';

type Kind = 'write-file' | 'write-folder' | 'read-file' | 'read-folder';

/** Each capability whose file is a person's, by what is done with it, its path input and what says "replace it". */
const FILE_CAPABILITIES: Readonly<Record<string, { readonly kind: Kind; readonly input: string; readonly replace?: { readonly input: string; readonly value: string }; readonly fallback?: (program: unknown) => string }>> = {
  'bundle.export': { kind: 'write-file', input: 'path', replace: { input: 'existing', value: 'replace' }, fallback: (program) => (program === 'agent' ? 'goodvibes-agent-bundle.json' : 'goodvibes-bundle.json') },
  'bundle.inspect': { kind: 'read-file', input: 'path' },
  'bundle.import': { kind: 'read-file', input: 'path' },
  'startup.support-bundle': { kind: 'write-folder', input: 'dir', replace: { input: 'overwrite', value: 'replace' } },
  'startup.support-bundle-inspect': { kind: 'read-folder', input: 'dir' },
  'startup.transfer-export': { kind: 'write-file', input: 'path', replace: { input: 'overwrite', value: 'replace' } },
  'startup.transfer-inspect': { kind: 'read-file', input: 'path' },
  'startup.transfer-import': { kind: 'read-file', input: 'path' },
  // The calendar file in and out (capabilities/builtin/calendar.ts): an existing file is never replaced.
  'calendar.import': { kind: 'read-file', input: 'path' },
  'calendar.export': { kind: 'write-file', input: 'dest' },
};

/** A refusal said in the daemon's words for the same case, before anything is sent. */
export class FileWorkRefusal extends Error {
  constructor(message: string, readonly next: string) { super(message); this.name = 'FileWorkRefusal'; }
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/**
 * The call as it goes out, and what to do with the answer. Throws a FileWorkRefusal when nothing is sent. The
 * platform's file helpers are loaded only here, for a daemon on another machine, so `do` stays light otherwise.
 */
async function prepare(body: Record<string, unknown>, cwd: string): Promise<{ readonly body: Record<string, unknown>; readonly after: (answer: unknown) => void } | undefined> {
  const id = typeof body.id === 'string' ? body.id : '';
  const rule = FILE_CAPABILITIES[id];
  if (!rule) return undefined;
  const { atomicWriteFileSync } = await import('@goodvibes/engine/platform/platform/config');
  const { SUPPORT_FOLDER_MARK } = await import('@goodvibes/engine/platform/platform/capabilities');
  const inputs = { ...record(body.inputs) } as Record<string, unknown>;
  if (inputs.filesAt !== undefined) return undefined;
  const project = typeof body.workingDirectory === 'string' && body.workingDirectory ? body.workingDirectory : cwd;
  const named = typeof inputs[rule.input] === 'string' && inputs[rule.input] ? String(inputs[rule.input]) : rule.fallback?.(inputs.program ?? body.program) ?? '';
  if (!named) return undefined;
  const local = isAbsolute(named) ? named : resolve(project, named);
  const replacing = rule.replace ? inputs[rule.replace.input] === rule.replace.value : false;
  const out = { ...body, inputs: { ...inputs, [rule.input]: named, filesAt: 'program' } } as Record<string, unknown>;
  const outInputs = out.inputs as Record<string, unknown>;
  switch (rule.kind) {
    case 'read-file': {
      if (!existsSync(local)) throw new FileWorkRefusal(`File not found: ${local}; nothing was read.`, 'Name a file on this computer.');
      outInputs.content = readFileSync(local, 'utf-8');
      return { body: out, after: () => {} };
    }
    case 'read-folder': {
      if (!existsSync(join(local, SUPPORT_FOLDER_MARK))) throw new FileWorkRefusal(`${local} holds no support folder; nothing was read.`, 'Save one first: "Save a support folder about this setup".');
      const files: Record<string, string> = {};
      for (const entry of readdirSync(local, { withFileTypes: true })) if (entry.isFile()) files[entry.name] = readFileSync(join(local, entry.name), 'utf-8');
      outInputs.content = JSON.stringify(files);
      return { body: out, after: () => {} };
    }
    case 'write-file': {
      if (existsSync(local) && !replacing) throw new FileWorkRefusal(`${local} already exists; nothing was written.`, 'Choose another file, or choose to replace it.');
      return {
        body: out,
        after: (answer) => {
          const file = record(record(record(answer).data).file);
          if (typeof file.content !== 'string') return;
          atomicWriteFileSync(local, file.content, { mkdirp: true });
        },
      };
    }
    case 'write-folder': {
      if (existsSync(join(local, SUPPORT_FOLDER_MARK)) && !replacing) throw new FileWorkRefusal(`${local} already holds a support folder; nothing was written.`, 'Choose another folder, or choose to replace it.');
      return {
        body: out,
        after: (answer) => {
          const files = record(record(answer).data).files;
          if (!Array.isArray(files)) return;
          mkdirSync(local, { recursive: true });
          for (const file of files.map(record)) {
            if (typeof file.name !== 'string' || typeof file.content !== 'string' || file.name !== basename(file.name)) continue;
            atomicWriteFileSync(join(local, file.name), file.content, { mkdirp: true });
          }
        },
      };
    }
  }
}

/**
 * What came of such a call that waited for the owner (`capabilities.run { approvalId }`): the file it made is written
 * here, at the name it was asked for (in this program's folder unless it is a full path), as the call that waited would
 * have. A file put at that place meanwhile is kept, and the answer says so. Undefined for any other call.
 */
async function heldOutcome(body: Record<string, unknown>, cwd: string): Promise<{ readonly after: (answer: unknown) => string | undefined } | undefined> {
  if (typeof body.approvalId !== 'string' || body.id !== undefined) return undefined;
  const { atomicWriteFileSync } = await import('@goodvibes/engine/platform/platform/config');
  return {
    after: (answer) => {
      const file = record(record(record(answer).data).file);
      if (typeof file.name !== 'string' || !file.name || typeof file.content !== 'string') return undefined;
      const local = isAbsolute(file.name) ? file.name : resolve(cwd, file.name);
      // Read again after it was written here (the same file): nothing more to do.
      if (existsSync(local)) {
        if (readFileSync(local, 'utf-8') === file.content) return undefined;
        return `${local} was put there while the call waited for the owner; it was kept and the file made was not written.`;
      }
      atomicWriteFileSync(local, file.content, { mkdirp: true });
      return undefined;
    },
  };
}

/** The answer as the program shows it: the file's content stays on this machine's disk, not in what is printed. */
function shown(answer: unknown): unknown {
  const top = record(answer);
  const data = record(top.data);
  if (data.file === undefined && data.files === undefined) return answer;
  const { file: _file, files: _files, ...rest } = data;
  return { ...top, data: rest };
}

/** This program's daemon caller, doing the file work here when the daemon is on another machine (`remote()`). */
export function withFileWorkHere(caller: DaemonVerbCaller, remote: () => boolean, cwd: () => string): DaemonVerbCaller {
  // Every other method answers as the caller's own (bound, so a class's own fields stay its).
  return {
    probe: () => caller.probe(),
    ...(caller.captureSettingsPrecondition ? { captureSettingsPrecondition: caller.captureSettingsPrecondition.bind(caller) } : {}),
    ...(caller.captureSettingsImportPrecondition ? { captureSettingsImportPrecondition: caller.captureSettingsImportPrecondition.bind(caller) } : {}),
    async invoke<T = unknown>(methodId: string, input?: unknown, options?: Parameters<DaemonVerbCaller['invoke']>[2]): Promise<T> {
      if (methodId !== 'capabilities.run' || !remote()) return caller.invoke<T>(methodId, input, options);
      const held = await heldOutcome(record(input), cwd());
      if (held) {
        const answer = await caller.invoke<T>(methodId, input, options);
        const kept = held.after(answer);
        if (kept) throw Object.assign(new Error(kept), { code: 'REFUSED', said: { error: kept, next: 'Move that file, then read what came of the call again.' } });
        return shown(answer) as T;
      }
      let prepared;
      try { prepared = await prepare(record(input), cwd()); } catch (error) {
        if (error instanceof FileWorkRefusal) throw Object.assign(new Error(error.message), { code: 'REFUSED', said: { error: error.message, next: error.next } });
        throw error;
      }
      if (!prepared) return caller.invoke<T>(methodId, input, options);
      const answer = await caller.invoke<T>(methodId, prepared.body, options);
      prepared.after(answer);
      return shown(answer) as T;
    },
  } as DaemonVerbCaller;
}

/** The same for a command-line form's invoke (`do`, `bundle`, `support-bundle`). */
export function cliWithFileWorkHere(invoke: CapabilityCliInvoke, remote: () => boolean, cwd: string): CapabilityCliInvoke {
  return async (methodId, input, options) => {
    if (methodId !== 'capabilities.run' || !remote()) return invoke(methodId, input, options);
    const held = await heldOutcome(input, cwd);
    if (held) {
      const answer = await invoke(methodId, input, options);
      if (!answer.ok) return answer;
      let kept: string | undefined;
      try { kept = held.after(answer.data); } catch (error) {
        return { ok: false, code: 'refused', error: `The file could not be written on this computer: ${error instanceof Error ? error.message : String(error)}`, fix: 'Check the folder can be written, then read what came of the call again.' };
      }
      if (kept) return { ok: false, code: 'refused', error: kept, fix: 'Move that file, then read what came of the call again.' };
      return { ok: true, data: shown(answer.data) };
    }
    let prepared;
    try { prepared = await prepare(input, cwd); } catch (error) {
      if (error instanceof FileWorkRefusal) return { ok: false, code: 'refused', error: error.message, fix: error.next };
      throw error;
    }
    if (!prepared) return invoke(methodId, input, options);
    const answer = await invoke(methodId, prepared.body, options);
    if (!answer.ok) return answer;
    try { prepared.after(answer.data); } catch (error) {
      return { ok: false, code: 'refused', error: `The file could not be written on this computer: ${error instanceof Error ? error.message : String(error)}`, fix: 'Check the folder can be written, then try again.' };
    }
    return { ok: true, data: shown(answer.data) };
  };
}
