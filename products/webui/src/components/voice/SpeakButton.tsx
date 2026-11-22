/**
 * SpeakButton, read an assistant reply aloud through the streaming TTS route.
 *
 * Honest states, no dead controls:
 *   - no configured voice provider  -> disabled, with the bring-your-own-key refusal.
 *   - browser can't play audio      -> disabled, with an honest reason.
 *   - ready & idle                  -> a speaker; click to speak (uses the SHARED voice).
 *   - this reply loading            -> a spinner; click cancels.
 *   - this reply playing            -> a stop square; click interrupts INSTANTLY.
 *
 * At most one reply is ever heard: the engine interrupts any prior playback when a new
 * Speak is clicked.
 */
import { Loader, Square, Volume2, VolumeX } from 'lucide-react';
import { useTts } from '../../lib/voice/useVoice';
import { TTS_UNAVAILABLE_MESSAGE } from '../../lib/voice/voice-config';
import { IconButton } from '../ui/IconButton';
import { MenuItem } from '../ui/Menu';
import '../../styles/components/voice.css';

interface SpeakButtonProps {
  readonly messageId: string;
  readonly sessionId?: string;
  readonly contentRevision?: string;
  readonly text: string;
}

export function SpeakButton({ messageId, sessionId, contentRevision, text }: SpeakButtonProps) {
  const { availability, canPlay, state, isActive, speak, stop } = useTts(sessionId && contentRevision ? { sessionId, messageId, contentRevision, content: text } : undefined);

  if (!text.trim()) return null;

  const active = isActive(messageId);
  const loading = active && state.phase === 'loading';
  const playing = active && state.phase === 'playing';

  if (!availability.ttsAvailable || !canPlay || !sessionId || !contentRevision) {
    const reason = !canPlay
      ? 'This browser cannot play synthesised audio.'
      : !availability.ttsAvailable ? TTS_UNAVAILABLE_MESSAGE : 'The saved reply is still loading.';
    return (
      <IconButton
        className="voice-speak-btn voice-unavailable"
        label={`Read aloud unavailable, ${reason}`}
        icon={<VolumeX aria-hidden />}
        disabled
      />
    );
  }

  if (loading) {
    return (
      <IconButton
        className="voice-speak-btn is-loading"
        label="Preparing spoken reply: click to cancel"
        icon={<Loader aria-hidden className="voice-spin" />}
        onClick={stop}
      />
    );
  }

  if (playing) {
    return (
      <IconButton
        className="voice-speak-btn is-playing"
        label="Stop reading aloud"
        icon={<Square aria-hidden />}
        onClick={stop}
      />
    );
  }

  return (
    <IconButton
      className="voice-speak-btn"
      label={state.error ? `Read aloud unavailable: ${state.error} Click to retry` : "Read this reply aloud"}
      icon={<Volume2 aria-hidden />}
      onClick={() => speak(messageId, text)}
    />
  );
}

/**
 * The same control as a menu item, for a message's "More" menu on a phone:
 * the same states in words ("Read aloud", "Stop reading aloud", or why it is
 * unavailable).
 */
export function SpeakMenuItem({ messageId, sessionId, contentRevision, text }: SpeakButtonProps) {
  const { availability, canPlay, state, isActive, speak, stop } = useTts(sessionId && contentRevision ? { sessionId, messageId, contentRevision, content: text } : undefined);
  if (!text.trim()) return null;
  const active = isActive(messageId);
  if (!availability.ttsAvailable || !canPlay || !sessionId || !contentRevision) {
    const reason = !canPlay
      ? 'This browser cannot play synthesised audio.'
      : !availability.ttsAvailable ? TTS_UNAVAILABLE_MESSAGE : 'The saved reply is still loading.';
    return <MenuItem icon={<VolumeX aria-hidden />} disabled wrap>{`Read aloud unavailable. ${reason}`}</MenuItem>;
  }
  if (active && (state.phase === 'loading' || state.phase === 'playing')) {
    return <MenuItem icon={<Square aria-hidden />} onSelect={stop}>Stop reading aloud</MenuItem>;
  }
  return <MenuItem icon={<Volume2 aria-hidden />} onSelect={() => speak(messageId, text)}>Read aloud</MenuItem>;
}
