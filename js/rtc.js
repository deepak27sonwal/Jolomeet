// One WebRTC connection between two matched people.
// Signalling runs over the match channel (api.joinMatchChannel):
//   ready  - the receiving side is listening (sent until an offer arrives)
//   hello  - the calling side is listening (asks the other side for "ready")
//   offer / answer - session descriptions, only the initiator makes offers
//   ice    - network candidates, queued until the remote description is set
//   bye    - the other person hung up
// Anything else (e.g. camera on/off) is left to the page.
import { ICE_SERVERS } from './config.js';

export class CallPeer {
  /**
   * @param {object} options
   * @param {MediaStream} options.stream  local microphone (and later camera)
   * @param {boolean} options.initiator   true on the side that sends the offer
   * @param {(payload: object) => void} options.send
   * @param {(stream: MediaStream) => void} options.onRemoteStream
   * @param {(state: string) => void} options.onState  RTCPeerConnection.connectionState
   */
  constructor({ stream, initiator, send, onRemoteStream, onState }) {
    this.initiator = initiator;
    this.send = send;
    this.offered = false;
    this.pendingIce = [];
    this.closed = false;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    pc.onicecandidate = (event) => {
      if (event.candidate) send({ kind: 'ice', candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => onRemoteStream(event.streams[0] || new MediaStream([event.track]));
    pc.onconnectionstatechange = () => onState(pc.connectionState);
  }

  /** Call once the match channel is subscribed. */
  announce() {
    this.send({ kind: this.initiator ? 'hello' : 'ready' });
  }

  async handle(message) {
    if (this.closed || !message?.kind) return;
    const pc = this.pc;
    switch (message.kind) {
      case 'hello':
        if (!this.initiator && !pc.remoteDescription) this.send({ kind: 'ready' });
        break;
      case 'ready':
        if (this.initiator && !this.offered) {
          this.offered = true;
          await pc.setLocalDescription(await pc.createOffer());
          this.send({ kind: 'offer', sdp: pc.localDescription.toJSON() });
        }
        break;
      case 'offer':
        if (!this.initiator && !pc.remoteDescription) {
          await pc.setRemoteDescription(message.sdp);
          await this.flushIce();
          await pc.setLocalDescription(await pc.createAnswer());
          this.send({ kind: 'answer', sdp: pc.localDescription.toJSON() });
        }
        break;
      case 'answer':
        if (this.initiator && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(message.sdp);
          await this.flushIce();
        }
        break;
      case 'ice':
        if (pc.remoteDescription) await pc.addIceCandidate(message.candidate).catch(() => {});
        else this.pendingIce.push(message.candidate);
        break;
      default:
        break;
    }
  }

  /** True once the offer/answer exchange has started (stop re-sending "ready"). */
  get negotiating() {
    return Boolean(this.pc.remoteDescription || this.pc.localDescription);
  }

  /** Swaps the outgoing camera or microphone track (e.g. front ↔ back camera) without renegotiating. */
  async replaceTrack(kind, track) {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === kind);
    if (sender) await sender.replaceTrack(track);
  }

  async flushIce() {
    const queued = this.pendingIce.splice(0);
    for (const candidate of queued) await this.pc.addIceCandidate(candidate).catch(() => {});
  }

  close() {
    this.closed = true;
    this.pc.ontrack = null;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}

/** Live 0–1 loudness of a stream, for the "speaking" ring. Returns a stop function. */
export function watchAudioLevel(stream, onLevel) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return () => {};
  const context = new AudioCtx();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  let frame = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += ((value - 128) / 128) ** 2;
    onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
    frame = requestAnimationFrame(tick);
  };
  context.resume().catch(() => {});
  tick();
  return () => {
    cancelAnimationFrame(frame);
    source.disconnect();
    context.close().catch(() => {});
  };
}
