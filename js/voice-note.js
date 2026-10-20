// Voice notes: recording with MediaRecorder and a small player for chat bubbles.
import { icon, esc } from './ui.js';

export const MAX_VOICE_SECONDS = 120;
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

export function canRecordVoice() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

/**
 * Starts recording from the microphone. Resolves with a recorder once the mic is on:
 *   recorder.elapsed()  seconds so far
 *   recorder.stop()     → Promise<{ blob, type, seconds }> (null if too short)
 *   recorder.cancel()   discards everything
 * onLimit is called when the note reaches MAX_VOICE_SECONDS (it stops by itself).
 */
export async function startRecording({ onLimit, maxSeconds = MAX_VOICE_SECONDS } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const startedAt = Date.now();
  recorder.start(250);

  let finished = null;
  const release = () => stream.getTracks().forEach((t) => t.stop());
  const finish = () => {
    finished ??= new Promise((resolve) => {
      recorder.onstop = () => {
        release();
        const seconds = Math.min(maxSeconds, Math.round((Date.now() - startedAt) / 1000));
        const mime = (recorder.mimeType || type || 'audio/webm').split(';')[0];
        resolve(seconds >= 1 && chunks.length ? { blob: new Blob(chunks, { type: mime }), type: mime, seconds } : null);
      };
      if (recorder.state !== 'inactive') recorder.stop();
      else recorder.onstop();
    });
    return finished;
  };
  const limit = setTimeout(() => { finish(); onLimit?.(); }, maxSeconds * 1000);

  return {
    elapsed: () => Math.min(maxSeconds, (Date.now() - startedAt) / 1000),
    stop: () => { clearTimeout(limit); return finish(); },
    cancel: () => {
      clearTimeout(limit);
      chunks.length = 0;
      recorder.ondataavailable = null;
      return finish();
    },
  };
}

export function formatSeconds(total) {
  const s = Math.max(0, Math.round(total));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Player markup for a voice message. `src` may be set later with hydrateVoicePlayers. */
export function voicePlayerHtml({ path = '', src = '', seconds = 0 }) {
  return `<div class="voice" data-voice-path="${esc(path)}"${src ? ` data-src="${esc(src)}"` : ''} data-seconds="${Number(seconds) || 0}">
    <button class="voice__play" type="button" aria-label="Play voice message">${icon('play', 'icon icon--filled')}</button>
    <span class="voice__track" aria-hidden="true"><span class="voice__progress"></span></span>
    <span class="voice__time">${formatSeconds(seconds)}</span>
  </div>`;
}

const audio = new Audio(); // one note plays at a time
let current = null;

function setPlaying(player, playing) {
  const button = player.querySelector('.voice__play');
  button.innerHTML = playing ? icon('pause') : icon('play', 'icon icon--filled');
  button.setAttribute('aria-label', playing ? 'Pause voice message' : 'Play voice message');
  player.classList.toggle('is-playing', playing);
}

audio.addEventListener('timeupdate', () => {
  if (!current) return;
  const total = Number(current.dataset.seconds) || audio.duration || 1;
  current.querySelector('.voice__progress').style.width = `${Math.min(100, (audio.currentTime / total) * 100)}%`;
  current.querySelector('.voice__time').textContent = formatSeconds(audio.currentTime);
});
audio.addEventListener('ended', () => {
  if (!current) return;
  setPlaying(current, false);
  current.querySelector('.voice__progress').style.width = '0%';
  current.querySelector('.voice__time').textContent = formatSeconds(Number(current.dataset.seconds));
  current = null;
});

/**
 * Makes players inside root work. resolveUrl(path) returns a playable link
 * (signed URL) for players that don't have one yet.
 */
export function hydrateVoicePlayers(root, resolveUrl) {
  root.querySelectorAll('.voice:not([data-ready])').forEach((player) => {
    player.dataset.ready = '1';
    player.querySelector('.voice__play').addEventListener('click', async () => {
      if (current === player && !audio.paused) {
        audio.pause();
        setPlaying(player, false);
        return;
      }
      if (current && current !== player) setPlaying(current, false);
      let src = player.dataset.src;
      if (!src) {
        try {
          src = await resolveUrl(player.dataset.voicePath);
          player.dataset.src = src;
        } catch {
          player.querySelector('.voice__time').textContent = 'Unavailable';
          return;
        }
      }
      if (audio.src !== src) audio.src = src;
      current = player;
      setPlaying(player, true);
      audio.play().catch(() => setPlaying(player, false));
    });
  });
}

/** Stop playback, e.g. when leaving a conversation. */
export function stopVoicePlayback() {
  audio.pause();
  if (current) setPlaying(current, false);
  current = null;
}
