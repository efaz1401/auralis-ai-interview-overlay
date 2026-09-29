/**
 * Audio capture for Live Answers.
 *
 * Electron-only by design. The main process answers `getDisplayMedia` with
 * `{ video: <screen>, audio: "loopback" }` via `setDisplayMediaRequestHandler`
 * (see electron/main.cjs), so system audio arrives with NO share dialog and no
 * "tick share tab audio" step. If that path ever returns a silent stream we
 * retry with the legacy `chromeMediaSource: "desktop"` constraints, which some
 * Windows audio stacks still prefer.
 */

export class CaptureError extends Error {
  hint: string;
  constructor(message: string, hint = "") {
    super(message);
    this.name = "CaptureError";
    this.hint = hint;
  }
}

export const isElectron = (): boolean => Boolean((window as any).electronOverlay?.isElectron);

/** Drop the video track — we only ever wanted the audio that rides along. */
function keepAudioOnly(stream: MediaStream): MediaStream {
  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }
  return stream;
}

function hasAudio(stream: MediaStream | null): stream is MediaStream {
  return Boolean(stream && stream.getAudioTracks().length > 0);
}

function discard(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Primary path: display-media loopback, resolved entirely in the main process. */
async function viaLoopback(): Promise<MediaStream | null> {
  try {
    // `video: true` is mandatory per spec; the handler supplies a screen source
    // and attaches loopback audio to it. We throw the video away immediately.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } as MediaTrackConstraints,
    });
    if (!hasAudio(stream)) {
      discard(stream);
      return null;
    }
    return keepAudioOnly(stream);
  } catch (err: any) {
    // NotAllowedError here means the handler called `callback({})` — usually no
    // screen source was available. Let the legacy path have a turn.
    console.warn("[Auralis] loopback capture failed:", err?.message || err);
    return null;
  }
}

/** Fallback path: legacy Chromium desktop constraints against a known source id. */
async function viaDesktopSource(sourceId?: string): Promise<MediaStream | null> {
  let id = sourceId;
  if (!id) {
    const sources = await window.electronOverlay?.getSources().catch(() => []);
    id = sources?.[0]?.id;
  }
  if (!id) return null;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "desktop" } },
      video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: id } },
    } as any);
    if (!hasAudio(stream)) {
      discard(stream);
      return null;
    }
    return keepAudioOnly(stream);
  } catch (err: any) {
    console.warn("[Auralis] desktop-source capture failed:", err?.message || err);
    return null;
  }
}

/**
 * Capture whatever the interviewer is saying through the computer's speakers.
 * Resolves with an audio-only MediaStream or throws a CaptureError carrying a
 * hint the UI can show verbatim.
 */
export async function captureSystemAudio(sourceId?: string): Promise<MediaStream> {
  if (!isElectron()) {
    throw new CaptureError(
      "System audio needs the Auralis desktop app.",
      "Run `npm run electron:dev` (or open the installed app) — the browser can't capture loopback audio without a share dialog. Microphone mode works here.",
    );
  }

  const stream = (await viaLoopback()) ?? (await viaDesktopSource(sourceId));
  if (!stream) {
    throw new CaptureError(
      "Captured the screen but no system audio came through.",
      "Play the interview call on this computer, make sure the output device isn't muted, then start again.",
    );
  }
  return stream;
}

/** Microphone capture — for speakerphone setups. */
export async function captureMicrophone(deviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false }
        : { echoCancellation: false, noiseSuppression: false },
      video: false,
    });
  } catch (err: any) {
    if (err?.name === "NotAllowedError") {
      throw new CaptureError("Microphone access was blocked.", "Allow microphone access in your system privacy settings, then try again.");
    }
    throw new CaptureError("Couldn't open the microphone.", err?.message || "Unknown error.");
  }
}

/** List input devices (labels only populate after permission is granted once). */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}

/**
 * Drive a 0-100 level meter off the stream. Returns a stop function.
 */
export function meterStream(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return () => {};

  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);

  const bins = new Uint8Array(analyser.frequencyBinCount);
  let frame = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    analyser.getByteFrequencyData(bins);
    let sum = 0;
    for (let i = 0; i < bins.length; i++) sum += bins[i];
    // Scale the average up — speech rarely fills the byte range.
    onLevel(Math.min(100, (sum / bins.length) * 2.2));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    try { source.disconnect(); } catch { /* already torn down */ }
    void ctx.close().catch(() => {});
  };
}

/** Pick a container MediaRecorder can actually produce on this build. */
export function pickRecorderMime(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}
