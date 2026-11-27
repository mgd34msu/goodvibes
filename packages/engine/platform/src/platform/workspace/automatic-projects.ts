/**
 * automatic-projects.ts, the project the daemon makes for a chat that has none.
 *
 * A chat with no project (a channel conversation whose channel has "Project for this channel" on None, a web chat
 * started with none, a web chat kept from 3.5.0 with none) is given a project the first time the OWNER's own message
 * there needs somewhere to work (a write, a command, Work, a schedule, a trigger, a memory "for this project"). It is
 * an ordinary, permanent project: a folder of its own inside "Folder for automatic projects"
 * (`storage.automaticProjectsFolder`, default `~/goodvibes-projects`), registered in the shared register like any
 * other (so its rules, trust, memory, checkpoints, Work, schedules, triggers, hooks and records are keyed to it by the
 * one project identity, and it is listed with every other project), its trust "trusted, nothing of its own to run"
 * (it is empty: the daemon made it for the owner's own message; a file it later brings asks them as any project does).
 *
 * Its name is a short lower-case folder name, picked by the decision model from names made from the message's words
 * (`workspace.automatic-project-name`); with no decision model set (silently) or one that failed (said), the chat's
 * kind and the date. A name taken already gets a number. The chat keeps its project from then on (a web chat in its
 * own record, a channel conversation in this module's record of conversations); another existing project can be
 * attached instead. Nothing here deletes anything: a chat deleted leaves its project, which is the owner's folder.
 *
 * Someone else's input never makes one (the hosts ask only for the owner's own turns). Making the folder is not put to
 * the owner: it is the direct effect of their own message; everything they do in it is decided under the settings in
 * force for it, as for any project.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { PRODUCT_WORKTREE_DIR_SEGMENTS } from '../git/product-worktree-marker.js';
import { NONE } from '@goodvibes/judgment';
import { judgmentPort } from '@goodvibes/engine/errors';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { judgedOrNot } from '../contract/judged-or-not.js';
import { automaticProjectName } from './batteries/automatic-project-name.js';
import { pathWithin, realPathOf, whyNeverAProject } from './caller-project.js';
import { registeredWorkspaceRoots } from './project-identity.js';

/** The setting, as its place shows it. */
export const AUTOMATIC_PROJECTS_SETTING = 'storage.automaticProjectsFolder';
/** Its default, in the owner's home folder. */
export const AUTOMATIC_PROJECTS_DEFAULT_NAME = 'goodvibes-projects';
const SITE = 'workspace.automatic-project-name';

/** The folder automatic projects are made in: the setting's (a `~/` path from `home`), else `~/goodvibes-projects`. */
export function automaticProjectsFolderOf(setting: unknown, home: string): string {
  const value = typeof setting === 'string' ? setting.trim() : '';
  if (!value) return join(home, AUTOMATIC_PROJECTS_DEFAULT_NAME);
  if (value === '~') return home;
  return value.startsWith('~/') ? join(home, value.slice(2)) : resolve(value);
}

export interface AutomaticProjectFacts {
  readonly homeDirectory: string;
  readonly goodVibesHome: string;
  readonly daemonHome: string;
}

/**
 * Why `folder` cannot hold automatic projects, or undefined: the never-a-project rules (never in or above the product's
 * homes), and never inside (or, through a link, into) a registered project or a project's worktree, read by real path: a
 * chat's project made there would be a folder of that project, its files that project's files, its hooks fired by
 * them, its checkpoints holding them, and a caller given that project would reach them.
 */
export function automaticProjectsFolderRefusal(folder: string, facts: AutomaticProjectFacts): string | undefined {
  if (!isAbsolute(folder)) return `${folder} is not the full path of a folder`;
  // The projects made inside it are what must pass: a child of the folder stands for them.
  const why = whyNeverAProject(join(folder, 'a-project'), facts) ?? whyNeverAProject(folder, facts);
  if (why) return `${folder} cannot hold projects: ${why}`;
  const real = realPathOf(folder);
  const holder = registeredWorkspaceRoots(facts.homeDirectory).map(realPathOf).filter((root) => pathWithin(real, root))
    .sort((a, b) => b.length - a.length)[0];
  if (holder) return `${folder} cannot hold projects: it is ${real === holder ? '' : 'inside '}the registered project ${holder}, and a chat's project there would be part of it`;
  const worktree = worktreeHolding(real);
  if (worktree) return `${folder} cannot hold projects: it is inside ${worktree}, a worktree of a project`;
  return undefined;
}

/** The worktree `path` is in, if any: a product worktree (`.goodvibes/.worktrees/...`), or a folder whose `.git` is a file (a linked worktree). */
function worktreeHolding(path: string): string | undefined {
  const marker = `${sep}${PRODUCT_WORKTREE_DIR_SEGMENTS.join(sep)}${sep}`;
  const at = `${path}${sep}`.indexOf(marker);
  if (at > 0) return path.slice(0, at + marker.length - 1);
  for (let folder = path; dirname(folder) !== folder; folder = dirname(folder)) {
    try { if (statSync(join(folder, '.git')).isFile()) return folder; } catch { /* no .git here */ }
  }
  return undefined;
}

/** The words of a message, as short lower-case folder names: each word, then neighbouring pairs, at most nine. */
export function projectNameCandidates(message: string): string[] {
  const words: string[] = [];
  for (const word of message.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
    if (word.length < 3 || STOP_WORDS.has(word) || words.includes(word)) continue;
    words.push(word.slice(0, 24));
    if (words.length >= 6) break;
  }
  const pairs: string[] = [];
  for (let at = 0; at + 1 < words.length && pairs.length < 3; at++) pairs.push(`${words[at]}-${words[at + 1]}`);
  return [...words, ...pairs].filter((name, index, all) => all.indexOf(name) === index).slice(0, 9);
}
const STOP_WORDS = new Set(['the', 'and', 'for', 'you', 'can', 'could', 'would', 'will', 'with', 'this', 'that', 'there', 'here',
  'please', 'into', 'from', 'about', 'what', 'when', 'where', 'which', 'some', 'any', 'all', 'our', 'your', 'mine', 'its',
  'are', 'was', 'were', 'have', 'has', 'had', 'not', 'but', 'then', 'than', 'them', 'they', 'just', 'also', 'make', 'let']);

/** A folder name: lower-case letters, digits and dashes, at most 40 characters, never empty. */
function folderName(text: string): string {
  const name = text.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40).replace(/-+$/u, '');
  return name || 'chat';
}

export interface AutomaticProjectAsk {
  /** The chat it is for: a web chat's id, a channel conversation's session id. */
  readonly key: string;
  /** The kind of chat: a channel's name (`telegram`, `homeassistant`), or `chat` for a web chat. */
  readonly kind: string;
  /** The owner's message that needed somewhere to work. */
  readonly message: string;
  readonly signal?: AbortSignal | undefined;
}

export interface AutomaticProject {
  readonly folder: string;
  readonly name: string;
  /** True when this call made it (false: the chat had it already). */
  readonly made: boolean;
  /** The one sentence the chat's row and its first answer say. */
  readonly said: string;
}

export interface AutomaticProjectsOptions extends AutomaticProjectFacts {
  /** `storage.automaticProjectsFolder`, read when a project is made. */
  readonly folderSetting: () => unknown;
  /** Makes the empty folder a project as a person's would be: a repository, so its Work has a history to work from. */
  readonly prepare?: ((folder: string, name: string) => void) | undefined;
  /** Registers the folder in the shared register (the daemon's store, as "Register a workspace" does). */
  readonly register: (folder: string, label: string) => Promise<void>;
  /** Records its trust: trusted, nothing of its own to run. */
  readonly trust: (folder: string) => Promise<void>;
  /** Where the record of channel conversations' projects is kept (the daemon's records). */
  readonly recordFile: string;
  readonly now?: (() => Date) | undefined;
}

/** A chat's project as recorded: `made` when it was made for the chat (else attached by the owner). */
interface Recorded { readonly folder: string; readonly name: string; readonly madeAt: string; readonly made?: boolean | undefined }

/** The sentence a chat says about where its files are. */
export function automaticProjectSentence(name: string, folder: string): string {
  return `This chat works in its own project, ${name}, made for it: its files are in ${folder}.`;
}

export class AutomaticProjects {
  readonly #options: AutomaticProjectsOptions;
  readonly #making = new Map<string, Promise<AutomaticProject>>();
  #record: Record<string, Recorded> | undefined;

  constructor(options: AutomaticProjectsOptions) {
    this.#options = options;
  }

  /** The folder automatic projects are made in now, or why it cannot be used. */
  folder(): { readonly folder: string } | { readonly refused: string } {
    const folder = automaticProjectsFolderOf(this.#options.folderSetting(), this.#options.homeDirectory || homedir());
    const refused = automaticProjectsFolderRefusal(folder, this.#options);
    return refused ? { refused } : { folder };
  }

  /** The project a channel conversation was given (made or attached), if any. */
  projectOf(key: string): string | undefined {
    const kept = this.#read()[key];
    return kept && existsSync(kept.folder) ? kept.folder : undefined;
  }

  /** Every conversation's project, for the record and its place. */
  list(): readonly { readonly key: string; readonly folder: string; readonly name: string; readonly made: boolean }[] {
    return Object.entries(this.#read()).map(([key, kept]) => ({ key, folder: kept.folder, name: kept.name, made: kept.made === true }));
  }

  /** Keeps `folder` (an existing project) as the conversation's project from now on. */
  attach(key: string, folder: string, name: string, made = false): void {
    this.#write({ ...this.#read(), [key]: { folder, name, madeAt: (this.#options.now?.() ?? new Date()).toISOString(), ...(made ? { made: true } : {}) } });
  }

  /** Every folder this daemon made for a chat (each stays the owner's project whatever the chat does later). */
  madeFolders(): readonly string[] {
    return Object.values(this.#read()).filter((kept) => kept.made === true).map((kept) => kept.folder);
  }

  /**
   * The conversation's project, made now when it has none (one at a time per conversation). `keep`: false for a host
   * that keeps the chat's project in the chat's own record (a web chat); true (default) records it here.
   */
  ensure(ask: AutomaticProjectAsk, keep = true): Promise<AutomaticProject> {
    const kept = keep ? this.projectOf(ask.key) : undefined;
    if (kept) {
      const name = this.#read()[ask.key]!.name;
      return Promise.resolve({ folder: kept, name, made: false, said: automaticProjectSentence(name, kept) });
    }
    const running = this.#making.get(ask.key);
    if (running) return running;
    const made = this.#make(ask, keep).finally(() => this.#making.delete(ask.key));
    this.#making.set(ask.key, made);
    return made;
  }

  async #make(ask: AutomaticProjectAsk, keep: boolean): Promise<AutomaticProject> {
    const where = this.folder();
    if ('refused' in where) throw new Error(`No project was made for this chat: ${where.refused}. Set "Folder for automatic projects" in System, Workspaces.`);
    const named = await this.#name(ask);
    mkdirSync(where.folder, { recursive: true, mode: 0o755 });
    const registered = new Set(registeredWorkspaceRoots(this.#options.homeDirectory).map((root) => realOf(root)));
    let folder = '';
    let name = '';
    for (let n = 1; n < 1000 && !folder; n++) {
      const candidate = n === 1 ? named.name : `${named.name}-${n}`;
      const path = join(where.folder, candidate);
      if (existsSync(path) || registered.has(realOf(path))) continue;
      try { mkdirSync(path, { mode: 0o755 }); } catch { continue; }
      folder = path;
      name = candidate;
    }
    if (!folder) throw new Error(`No project was made for this chat: every name like ${named.name} in ${where.folder} is taken.`);
    this.#options.prepare?.(folder, name);
    await this.#options.register(folder, name);
    await this.#options.trust(folder);
    // Recorded for every chat (its row says the project was made for it); a host that keeps the chat's project in the
    // chat's own record (`keep` false) reads it from there, never from here.
    this.attach(keep ? ask.key : `made:${ask.key}`, folder, name, true);
    logger.info('[projects] a project was made for a chat that had none', { kind: ask.kind, folder, judged: named.notJudged === undefined });
    const said = automaticProjectSentence(name, folder)
      + (named.notJudged ? ` (The decision model could not name it, ${named.notJudged}, so it is named by the chat's kind and the date.)` : '');
    return { folder, name, made: true, said };
  }

  /** The decision model's pick among the message's words; the chat's kind and the date when it picks none or cannot. */
  async #name(ask: AutomaticProjectAsk): Promise<{ readonly name: string; readonly notJudged?: string }> {
    const fallback = folderName(`${ask.kind}-${(this.#options.now?.() ?? new Date()).toISOString().slice(0, 10)}`);
    const candidates = projectNameCandidates(ask.message).map((id) => ({ id, content: id }));
    if (candidates.length === 0) return { name: fallback };
    return judgedOrNot<{ readonly name: string; readonly notJudged?: string }>(SITE, async () => {
      const picked = await automaticProjectName.select(judgmentPort(SITE), { message: ask.message.slice(0, 2000), kind: ask.kind }, candidates,
        { site: SITE, ...(ask.signal ? { signal: ask.signal } : {}) });
      const chosen = picked.chosen && picked.chosen !== NONE && picked.outcome !== 'escalate' ? picked.chosen : undefined;
      picked.recordAction(chosen ? 'named' : 'fallback');
      return { name: chosen ? folderName(chosen) : fallback };
    }, (notJudged) => ({ name: fallback, ...(notJudged ? { notJudged } : {}) }));
  }

  #read(): Record<string, Recorded> {
    if (this.#record) return this.#record;
    try {
      const parsed = JSON.parse(readFileSync(this.#options.recordFile, 'utf8')) as { version?: number; chats?: Record<string, Recorded> };
      this.#record = parsed.version === 1 && parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('[projects] the record of chats\' projects could not be read; it is written again', { file: this.#options.recordFile, error: summarizeError(error) });
      this.#record = {};
    }
    return this.#record;
  }

  #write(chats: Record<string, Recorded>): void {
    this.#record = chats;
    writeJsonFileAtomic(this.#options.recordFile, { version: 1, chats }, { mode: 0o600, mkdirp: true });
  }
}

function realOf(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** True when `folder` holds nothing yet (a project just made). */
export function folderIsEmpty(folder: string): boolean {
  try { return readdirSync(folder).length === 0; } catch { return false; }
}
