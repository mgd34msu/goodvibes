import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { VoiceAudioChunk } from '@goodvibes/engine/platform/platform/voice';

export interface StreamingAudioPlayerCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly label: string;
}

export interface StreamingAudioPlayer {
  readonly label: string;
  readonly available: boolean;
  play(chunks: AsyncIterable<VoiceAudioChunk>, options: StreamingAudioPlaybackOptions): Promise<void>;
  stop(): void;
  /**
   * Resolves once the currently playing sink has finished naturally (its
   * process closed) or after `timeoutMs`, whichever comes first; resolves
   * immediately when nothing is playing. The exit path uses this to let the
   * audio the user is already hearing finish inside a short bounded window
   * instead of killing it mid-drain. stop() remains the instant cut.
   */
  waitForDrain(timeoutMs: number): Promise<void>;
}

export interface StreamingAudioPlaybackOptions {
  readonly format?: string;
  readonly signal?: AbortSignal;
}

interface SpawnProcess {
  readonly stdin: Writable;
  /** The player's error output; its last line names why a sound could not be played. */
  readonly stderr?: Readable | null | undefined;
  once(event: 'close', listener: (code?: number | null, signal?: NodeJS.Signals | null) => void): this;
  once(event: 'spawn', listener: () => void): this;
  once(event: 'error', listener: (error: unknown) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}
type SpawnProcessFactory = (command: string, args: readonly string[]) => SpawnProcess;

export interface LocalStreamingAudioPlayerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnProcess?: SpawnProcessFactory;
  /**
   * Injected player command, the test seam companion to `spawnProcess`.
   * When set, the constructor uses it verbatim instead of scanning PATH, so
   * deterministic fake-sink tests never depend on mpv/ffplay being installed
   * on the machine running them. Pass null to model "no player found".
   */
  readonly command?: StreamingAudioPlayerCommand | null;
}

/**
 * The terminal's one audio output. Speech and the wake chime share it so that
 * `/voice stop` and quitting cut every sound it started, not only the last one.
 */
export class LocalStreamingAudioPlayer implements StreamingAudioPlayer {
  readonly command: StreamingAudioPlayerCommand | null;
  /** Every sink still running; a deliberate stop removes it before killing it. */
  private readonly live = new Set<SpawnProcess>();
  private readonly spawnProcess: SpawnProcessFactory;

  constructor(options: LocalStreamingAudioPlayerOptions = {}) {
    this.command = options.command !== undefined
      ? options.command
      : resolveStreamingAudioPlayerCommand(options.env ?? process.env);
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  }

  get label(): string {
    return this.command?.label ?? 'no streaming audio player found';
  }

  get available(): boolean {
    return this.command !== null;
  }

  async play(chunks: AsyncIterable<VoiceAudioChunk>, options: StreamingAudioPlaybackOptions = {}): Promise<void> {
    if (!this.command) {
      throw new Error('No streaming audio player found. Install mpv or ffplay to hear answers spoken (/voice).');
    }
    if (options.signal?.aborted) return;

    const label = this.command.label;
    const proc = this.spawnProcess(this.command.command, buildPlayerArgs(this.command, options.format));
    this.live.add(proc);
    const lastError = trackLastErrorLine(proc);
    const abort = () => {
      try { proc.stdin.destroy(); } catch { /* ignore */ }
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    // A sink cut on purpose (abort signal or stop()) is not a playback failure, whatever it exits with.
    const cut = () => options.signal?.aborted === true || !this.live.has(proc);
    // Recorded from spawn so a sink that died between chunks is not waited on for a 'close' that already fired.
    let closed = false;
    // How the player ended: its exit code, or the signal that stopped it (a crash, or the audio server killing it).
    const exited = new Promise<PlayerExit>((resolve) => {
      proc.once('close', (code, signal) => {
        closed = true;
        resolve({ code: typeof code === 'number' ? code : null, signal: typeof signal === 'string' ? signal : null });
      });
    });
    let playedOut = false;

    try {
      // Head survival: hold the first audio byte until the sink has actually
      // started (its 'spawn' event) instead of writing into a process that has
      // not exec'd yet. Writing before the player is up is the spawn race that
      // clipped the beginning of playback. A spawn failure rejects here so the
      // caller can report it honestly rather than swallowing a dead player.
      await awaitReady(proc, options.signal);
      if (cut()) return;

      for await (const chunk of chunks) {
        if (cut()) break;
        if (chunk.data.byteLength === 0) continue;
        try {
          await writeStdin(proc, chunk.data);
        } catch (error) {
          // An intentional interrupt destroys stdin under a pending write; that is not a playback failure.
          if (cut()) return;
          // A closed pipe means the player went away; its exit code and last error line say why.
          abort();
          const exit = await exited;
          if (cut()) return;
          throw playerFailure(label, exit, lastError(), error);
        }
      }

      // An intentional interrupt (turn cancel / quit chord / /voice stop) has
      // already torn the process down and must cut immediately, do not wait
      // on a graceful drain. A natural end-of-speech, by contrast, closes
      // stdin and waits for the sink to play out every buffered sample so the
      // tail of the response is never truncated.
      if (cut()) return;
      try { proc.stdin.end(); } catch { /* ignore */ }
      const exit = await exited;
      playedOut = true;
      // A signal we did not send (cut() is false) is a failure too: the sound did not finish.
      if (!cut() && ((exit.code !== null && exit.code !== 0) || (exit.code === null && exit.signal !== null))) {
        throw playerFailure(label, exit, lastError());
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);
      // A failed stream (the chunk iterator threw) must not leave the sink reading stdin forever. A natural drain is left alone so the tail is not cut.
      if (!playedOut && !closed) abort();
      this.live.delete(proc);
    }
  }

  stop(): void {
    const procs = [...this.live];
    this.live.clear();
    for (const proc of procs) {
      try { proc.stdin.destroy(); } catch { /* ignore */ }
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }

  waitForDrain(timeoutMs: number): Promise<void> {
    const procs = [...this.live];
    if (procs.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let open = procs.length;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, timeoutMs);
      for (const proc of procs) proc.once('close', () => { if (--open === 0) settle(); });
    });
  }
}

let sharedPlayer: LocalStreamingAudioPlayer | undefined;

/**
 * The process's one terminal audio player, built (and PATH scanned) on first use.
 * Spoken turns and the wake chime both default to it.
 */
export function sharedStreamingAudioPlayer(): LocalStreamingAudioPlayer {
  sharedPlayer ??= new LocalStreamingAudioPlayer();
  return sharedPlayer;
}

/** Keep the last non-empty line the player wrote to stderr, bounded so a chatty player costs nothing. */
function trackLastErrorLine(proc: SpawnProcess): () => string {
  let tail = '';
  proc.stderr?.on('data', (data: Buffer | string) => {
    tail = (tail + String(data)).slice(-512);
  });
  return () => {
    const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    return lines.at(-1) ?? '';
  };
}

interface PlayerExit {
  readonly code: number | null;
  readonly signal: string | null;
}

function playerFailure(label: string, exit: PlayerExit, lastLine: string, cause?: unknown): Error {
  const detail = lastLine ? `: ${lastLine}` : '';
  const { code, signal } = exit;
  if (code !== null && code !== 0) {
    return new Error(`the audio player (${label}) exited with code ${code}${detail}`, cause === undefined ? undefined : { cause });
  }
  if (code === null && signal !== null) {
    return new Error(`the audio player (${label}) was stopped by ${signal} before the sound finished${detail}`, cause === undefined ? undefined : { cause });
  }
  const reason = cause instanceof Error ? cause.message : String(cause ?? 'it stopped reading audio');
  return new Error(`the audio player (${label}) stopped before the sound finished (${reason})${detail}`, cause === undefined ? undefined : { cause });
}

export function resolveStreamingAudioPlayerCommand(env: NodeJS.ProcessEnv = process.env): StreamingAudioPlayerCommand | null {
  const mpv = findExecutable('mpv', env);
  if (mpv) {
    // No --cache=no: mpv's read-ahead cache buffers the incoming pipe so the
    // opening audio survives device-open latency and network jitter instead of
    // underrunning while the output device is still spinning up.
    return {
      command: mpv,
      args: ['--no-terminal', '--really-quiet', '--force-window=no', '-'],
      label: 'mpv',
    };
  }
  const ffplay = findExecutable('ffplay', env);
  if (ffplay) {
    return {
      command: ffplay,
      args: FFPLAY_BASE_ARGS,
      label: 'ffplay',
    };
  }
  return null;
}

// ffplay -autoexit quits as soon as its input ends, before the audio output
// buffer has drained, that clips the tail of the response. `apad` appends a
// short run of silence so the real audio is fully played out and only the
// trailing silence gets trimmed.
const FFPLAY_APAD = ['-af', 'apad=pad_dur=0.3'] as const;
const FFPLAY_BASE_ARGS = ['-nodisp', '-autoexit', '-loglevel', 'error', ...FFPLAY_APAD, '-i', 'pipe:0'] as const;

function buildPlayerArgs(command: StreamingAudioPlayerCommand, format?: string): readonly string[] {
  if (command.label !== 'ffplay' || !format) return command.args;
  const normalized = format.trim().toLowerCase();
  if (!normalized || normalized.includes('/')) return command.args;
  return ['-nodisp', '-autoexit', '-loglevel', 'error', ...FFPLAY_APAD, '-f', normalized, '-i', 'pipe:0'];
}

/**
 * awaitReady, resolves once the spawned player has actually started (its
 * 'spawn' event), rejects if it fails to start ('error'), and resolves early
 * if the caller aborts during startup so an intentional interrupt is never
 * blocked. This is the readiness gate that keeps the first audio byte from
 * being written into a not-yet-running sink.
 */
function awaitReady(proc: SpawnProcess, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const onSpawn = () => settle(resolve);
    const onError = (error: unknown) => settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    const onAbort = () => settle(resolve);
    proc.once('spawn', onSpawn);
    proc.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Whether `name` is runnable from PATH, and where.
 *
 * Exported for capture.ts, which needs the SAME scan: a host where playback finds
 * its tool and capture does not must be a real difference in what is installed,
 * never a difference in how the two looked for it.
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv, platform: string = process.platform): string | null {
  const pathValue = env.PATH ?? '';
  const extensions = platform === 'win32'
    ? ['', '.exe', '.cmd', '.bat']
    : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return null;
}

function defaultSpawnProcess(command: string, args: readonly string[]): SpawnProcess {
  return spawn(command, [...args], { stdio: ['pipe', 'ignore', 'pipe'] });
}

function writeStdin(proc: SpawnProcess, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    proc.stdin.write(Buffer.from(data), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
