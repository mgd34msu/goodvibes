/**
 * The browser's own speech recognition (the Web Speech API), offered for
 * dictation only when the daemon has no speech-to-text provider. It is a
 * different route from every other surface's: the browser sends the audio to
 * its maker's speech service, so the composer offers it as a choice with that
 * said, never by itself. The words land in the draft for review, never sent.
 *
 * Present only in a secure context, as the microphone is.
 */

interface RecognitionResultList {
  readonly length: number;
  readonly [index: number]: { readonly isFinal: boolean; readonly [alternative: number]: { readonly transcript: string } };
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { readonly results: RecognitionResultList }) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  if (typeof window === 'undefined' || !window.isSecureContext) return undefined;
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/** Whether this browser can recognise speech itself. */
export function browserSpeechAvailable(): boolean {
  return recognitionConstructor() !== undefined;
}

export interface BrowserDictation {
  /** Stop listening; what was heard so far is handed on. */
  readonly stop: () => void;
}

/**
 * Listen until the person stops talking (or `stop`), then hand the words to
 * `onText`; `onEnd` says it finished, with the browser's reason when it failed.
 */
export function dictateWithBrowser(onText: (text: string) => void, onEnd: (failure?: string) => void): BrowserDictation | undefined {
  const Ctor = recognitionConstructor();
  if (!Ctor) return undefined;
  const recognition = new Ctor();
  recognition.lang = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  recognition.interimResults = false;
  recognition.continuous = false;
  let heard = '';
  let failure: string | undefined;
  recognition.onresult = (event) => {
    const parts: string[] = [];
    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result?.isFinal) parts.push(result[0]?.transcript ?? '');
    }
    heard = parts.join(' ').trim();
  };
  recognition.onerror = (event) => {
    failure = event.error === 'not-allowed' || event.error === 'service-not-allowed'
      ? 'Microphone access was blocked. Allow it in your browser settings, then try again.'
      : event.error === 'no-speech' ? 'Nothing was heard. Try again.'
        : event.error === 'network' ? 'The browser could not reach its speech service.'
          : `The browser's speech recognition stopped (${event.error}).`;
  };
  recognition.onend = () => {
    if (heard) onText(heard);
    onEnd(failure);
  };
  recognition.start();
  return { stop: () => recognition.stop() };
}
