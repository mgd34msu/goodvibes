/**
 * round-trip-proof.ts, provisioning ends by PROVING the runtime works.
 *
 * "Provisioned" used to mean "the bytes are on disk and the checksums matched".
 * That is not the claim anyone cares about. On the owner's machine every byte
 * was present and verified, the install reported success, and speech-to-text
 * did not work, because the config still pointed at a different install. The
 * install was right about everything it checked and wrong about the only thing
 * that mattered.
 *
 * So the last act of provisioning is a real round trip: SYNTHESIZE a known
 * phrase with the managed TTS, TRANSCRIBE the resulting audio with the managed
 * STT, and compare. What comes back is shown to the user verbatim, the proof
 * is the text, not a green tick. If it fails, provisioning reports NOT
 * provisioned, with the stage that failed and the exception, because a false
 * "ready" costs a whole session and an honest failure costs a retry.
 *
 * The engine invocation contracts are the same ones providers/local.ts uses; a
 * proof that ran the binaries differently would prove something the product
 * does not do.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSttArgs, localTtsArgs, runLocalEngine, type LocalEngineRunner } from '../providers/local.js';

/**
 * The phrase the proof speaks. Deliberately plain, common words: the point is
 * to prove the pipeline runs end to end, not to benchmark a small model on
 * vocabulary it was never going to get right.
 */
export const VOICE_PROOF_PHRASE = 'the quick brown fox jumps over the lazy dog';

/**
 * Word substitutions, insertions or deletions the transcript may differ by and
 * still prove the round trip. One: a small model writing "jumped" for "jumps"
 * still heard the phrase, and both engines plainly ran.
 */
export const VOICE_PROOF_MAX_WORD_EDITS = 1;

/** The engine runner the proof uses: the local provider's own, unless a test injects one. */
export type ProofEngineRunner = LocalEngineRunner;

/** Who may still want the proof: the caller's abort signal and its own currency check. */
export interface VoiceProofLifetime {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

export function assertVoiceProofCurrent(lifetime: VoiceProofLifetime): void {
  lifetime.signal?.throwIfAborted();
  lifetime.assertCurrent?.();
}

export interface VoiceRoundTripProofOptions extends VoiceProofLifetime {
  readonly ttsEngine: string;
  readonly ttsBinary: string;
  readonly ttsModelPath: string;
  readonly sttEngine: string;
  readonly sttBinary: string;
  readonly sttModelPath: string;
  readonly phrase?: string | undefined;
  readonly runner?: ProofEngineRunner | undefined;
  readonly timeoutMs?: number | undefined;
  /** Injectable so a test needs no temp directory. */
  readonly scratchDir?: string | undefined;
}

/** What the proof did, in enough detail to report it honestly either way. */
export interface VoiceRoundTripProof {
  /** How the transcript was compared: its ordered words, in code. */
  readonly proofBasis?: 'native-word-sequence';
  readonly proved: boolean;
  /** Whether the transcript says the phrase; absent if an engine stage failed. */
  readonly comparison?: 'yes' | 'no' | undefined;
  /** Which stage ran last: `synthesize`, `transcribe`, or `compare`. */
  readonly stage: 'synthesize' | 'transcribe' | 'compare';
  readonly phrase: string;
  /** What the managed STT actually returned. Shown verbatim. */
  readonly transcript?: string | undefined;
  /** Fraction of the phrase's words that came back. */
  readonly wordOverlap?: number | undefined;
  /** The exception text when a stage failed. */
  readonly error?: string | undefined;
  /** One sentence a surface can print as-is. */
  readonly summary: string;
}

/** Lower-cased Unicode word tokens, punctuation dropped. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/** Fraction of `expected`'s distinct words that appear in `actual`. */
export function transcriptWordOverlap(expected: string, actual: string): number {
  const wanted = new Set(words(expected));
  if (wanted.size === 0) return 0;
  const got = new Set(words(actual));
  let hits = 0;
  for (const word of wanted) if (got.has(word)) hits += 1;
  return hits / wanted.size;
}

/** Word-level edit distance between two token lists. */
function wordEdits(expected: readonly string[], actual: readonly string[]): number {
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let i = 1; i <= expected.length; i++) {
    const row = [i];
    for (let j = 1; j <= actual.length; j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (expected[i - 1] === actual[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[actual.length]!;
}

/**
 * Speak a phrase with the managed TTS and read it back with the managed STT.
 *
 * Engine failures are reported by stage. Cancellation and the deadline reject
 * instead of publishing a stale result. The comparison is code: the ordered
 * words, allowing {@link VOICE_PROOF_MAX_WORD_EDITS}.
 */
export async function proveVoiceRoundTrip(options: VoiceRoundTripProofOptions): Promise<VoiceRoundTripProof> {
  const phrase = options.phrase ?? VOICE_PROOF_PHRASE;
  const runner = options.runner ?? runLocalEngine;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647, Math.floor(timeoutMs))));
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const lifetime: VoiceProofLifetime = { signal, assertCurrent: options.assertCurrent };
  const check = () => assertVoiceProofCurrent(lifetime);
  check();
  const scratch = options.scratchDir ?? mkdtempSync(join(tmpdir(), 'gv-voice-proof-'));
  const wavPath = join(scratch, 'proof.wav');

  try {
    try {
      await runner({ binary: options.ttsBinary, args: localTtsArgs(options.ttsModelPath, wavPath), stdinText: phrase, timeoutMs, signal });
      check();
      // The engine may exit 0 and still have written nothing; reading it is the
      // check that the audio exists at all.
      if (readFileSync(wavPath).byteLength === 0) throw new Error('the synthesized audio file is empty');
    } catch (error) {
      check();
      const detail = error instanceof Error ? error.message : String(error);
      return {
        proved: false,
        stage: 'synthesize',
        phrase,
        error: detail,
        summary: `The managed text-to-speech engine (${options.ttsEngine}) could not speak the test phrase: ${detail}`,
      };
    }

    let transcript: string;
    try {
      const { stdout } = await runner({ binary: options.sttBinary, args: localSttArgs(options.sttEngine, options.sttModelPath, wavPath), timeoutMs, signal });
      check();
      transcript = stdout.trim();
    } catch (error) {
      check();
      const detail = error instanceof Error ? error.message : String(error);
      return {
        proved: false,
        stage: 'transcribe',
        phrase,
        error: detail,
        summary: `The managed speech-to-text engine (${options.sttEngine}) could not transcribe the spoken test phrase: ${detail}`,
      };
    }

    const expected = words(phrase);
    const proved = expected.length > 0 && wordEdits(expected, words(transcript)) <= VOICE_PROOF_MAX_WORD_EDITS;
    return {
      proofBasis: 'native-word-sequence',
      proved,
      comparison: proved ? 'yes' : 'no',
      stage: 'compare',
      phrase,
      transcript,
      wordOverlap: transcriptWordOverlap(phrase, transcript),
      summary: proved
        ? `Spoke "${phrase}" with ${options.ttsEngine} and heard it back through ${options.sttEngine} as "${transcript}".`
        : `Spoke "${phrase}" with ${options.ttsEngine} and ${options.sttEngine} returned "${transcript}", which does not say the test phrase. Both engines ran; check that the speech-to-text model is the managed one, then reinstall.`,
    };
  } finally {
    if (options.scratchDir === undefined) rmSync(scratch, { recursive: true, force: true });
  }
}
