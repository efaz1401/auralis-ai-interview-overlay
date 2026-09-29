/**
 * LiveEngine — the whole live-copilot pipeline, framework-free.
 *
 *   audio ──▶ Deepgram WS (server proxy) ──▶ rolling buffer
 *                 │  (fallback: chunked MediaRecorder ─▶ /api/transcribe-only)
 *                 ▼
 *      endpoint detector ──▶ /api/segment-questions ──▶ question chips
 *                                                              │
 *              AUTO: stream an answer immediately              │
 *              MANUAL: park as a clickable chip in the rail    ▼
 *                                  barge-in scheduler ──▶ /api/live-answer-stream (SSE)
 *
 * Barge-in ("stack"): in AUTO mode a newer question always wins — the in-flight
 * answer is aborted, parked, and resumed newest-first once the queue drains.
 *
 * Speech-to-text is Deepgram only. The key lives in the server .env; the
 * renderer never sees it. There is NO Web Speech API fallback.
 */

import {
  captureMicrophone,
  captureSystemAudio,
  CaptureError,
  meterStream,
  pickRecorderMime,
} from "./capture";
import { blobToBase64, postJson } from "./http";
import { streamAnswer, streamScreenAnalysis, type StreamHandlers } from "./stream";
import type {
  AnswerMode,
  CaptureMode,
  DetectedQuestion,
  LiveContext,
  Phase,
  Turn,
  TurnSource,
} from "./types";

/** How much audio each transcription request covers (chunked fallback path). */
const CHUNK_MS = 2500;
/** Quiet gap that marks "the interviewer finished a thought". */
const SILENCE_MS = 1000;
/** Force segmentation once the buffer gets this long, even mid-sentence. */
const MAX_BUFFER_WORDS = 55;
/** Endpoint detector poll interval. */
const WATCH_MS = 250;
/** Deltas are batched and painted on this cadence to avoid per-token renders. */
const PAINT_MS = 50;
/** Give up on a stream that goes this long without a single byte. */
const STALL_MS = 45000;
/** Turns kept in memory. */
const MAX_TURNS = 40;
/** Question chips kept in the rail. */
const MAX_CHIPS = 30;
/** Answers used as conversation context for follow-up questions. */
const HISTORY_TURNS = 3;

export interface EngineState {
  phase: Phase;
  mode: CaptureMode;
  answerMode: AnswerMode;
  turns: Turn[];
  /** Question chips crystallised from the transcript. */
  questions: DetectedQuestion[];
  /** Live, not-yet-segmented interviewer speech. */
  interim: string;
  level: number;
  status: string;
  /** Fatal-ish problem: capture stopped or nothing can be answered. */
  error: string;
  /** Recoverable problem: capture continues. */
  warning: string;
  /** Questions waiting (queued + parked). Drives the "N waiting" badge. */
  pending: number;
  model: string;
}

type Emit = (state: EngineState) => void;

const uid = (() => {
  let n = 0;
  return () => `t${++n}-${performance.now().toFixed(0)}`;
})();

type StreamStarter = (handlers: StreamHandlers, signal: AbortSignal) => Promise<void>;

export class LiveEngine {
  private emit: Emit;
  private apiConfig: unknown;
  private context: LiveContext;

  // ── observable state ──────────────────────────────────────────────────────
  private phase: Phase = "idle";
  private mode: CaptureMode = "system";
  private answerMode: AnswerMode = "auto";
  private turns: Turn[] = [];
  private questions: DetectedQuestion[] = [];
  private interim = "";
  private level = 0;
  private status = "";
  private error = "";
  private warning = "";
  private model = "";

  // ── capture ───────────────────────────────────────────────────────────────
  private active = false;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private stopMeter: (() => void) | null = null;
  private chunkTimer: number | null = null;
  private watchTimer: number | null = null;
  // Deepgram real-time streaming
  private dgWs: WebSocket | null = null;
  private dgCtx: AudioContext | null = null;
  private dgProcessor: ScriptProcessorNode | null = null;

  // ── transcript ────────────────────────────────────────────────────────────
  private buffer = "";
  private lastHeardAt = 0;
  private lastChunkText = "";
  /** Serialises transcription requests so words can't arrive out of order. */
  private sttChain: Promise<void> = Promise.resolve();
  private segmenting = false;

  /** Set by dispose(); any async work still in flight must bail out. */
  private disposed = false;

  // ── answering ─────────────────────────────────────────────────────────────
  /** FIFO of fresh questions. */
  private queue: Array<{ question: string; source: TurnSource; screenImage?: string; screenMime?: string }> = [];
  /** LIFO of turns interrupted by a newer question. */
  private parked: Turn[] = [];
  private draining = false;
  private abort: AbortController | null = null;
  /** Id of the turn currently streaming, so barge-in can target it. */
  private activeTurnId: string | null = null;
  private paintTimer: number | null = null;

  constructor(apiConfig: unknown, context: LiveContext, emit: Emit) {
    this.apiConfig = apiConfig;
    this.context = context;
    this.emit = emit;
  }

  /** Props change on every parent render; keep the engine's copy fresh. */
  update(apiConfig: unknown, context: LiveContext) {
    this.apiConfig = apiConfig;
    this.context = context;
  }

  snapshot(): EngineState {
    return {
      phase: this.phase,
      mode: this.mode,
      answerMode: this.answerMode,
      turns: this.turns,
      questions: this.questions,
      interim: this.interim,
      level: this.level,
      status: this.status,
      error: this.error,
      warning: this.warning,
      pending: this.queue.length + this.parked.length,
      model: this.model,
    };
  }

  private publish() {
    this.emit(this.snapshot());
  }

  // ══ lifecycle ═════════════════════════════════════════════════════════════

  setMode(mode: CaptureMode) {
    if (this.phase !== "idle") return;
    this.mode = mode;
    this.error = "";
    this.publish();
  }

  /** AUTO answers every detected question; MANUAL parks them as chips. */
  setAnswerMode(mode: AnswerMode) {
    this.answerMode = mode;
    this.publish();
  }

  async start(mode: CaptureMode, deviceId?: string) {
    if (this.phase !== "idle") return;

    this.mode = mode;
    this.phase = "starting";
    this.error = "";
    this.warning = "";
    this.buffer = "";
    this.interim = "";
    this.lastChunkText = "";
    this.status = mode === "system" ? "Opening system audio…" : "Opening microphone…";
    this.publish();

    try {
      const stream = mode === "system"
        ? await captureSystemAudio(deviceId)
        : await captureMicrophone(deviceId);

      // StrictMode double-mount: the engine may have been disposed while the
      // capture promise was in flight — release the tracks and bail.
      if (this.disposed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      this.stream = stream;
      this.active = true;
      this.lastHeardAt = performance.now();

      // A track that ends on its own (device unplugged, screen share revoked)
      // must stop the session rather than leave a dead meter running.
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => {
          if (this.active) {
            this.warning = "The audio source ended — capture stopped.";
            this.stop();
          }
        });
      }

      this.stopMeter = meterStream(stream, (level) => {
        // Only publish on a visible change; this fires per animation frame.
        if (Math.abs(level - this.level) < 1.5) return;
        this.level = level;
        this.publish();
      });

      this.phase = "live";
      this.status = "Listening for the interviewer…";
      this.publish();

      this.startWatcher();

      // Deepgram real-time streaming is the primary path (key lives on the
      // server). The chunked recorder path is the fallback if the WS fails.
      this.startDeepgramStream();
    } catch (err: any) {
      this.teardown();
      this.phase = "idle";
      this.status = "";
      this.error = err instanceof CaptureError
        ? `${err.message} ${err.hint}`.trim()
        : err?.message || "Couldn't start listening.";
      this.publish();
    }
  }

  /** Stop listening. Any complete-looking trailing question still becomes a chip. */
  stop() {
    const leftover = this.buffer.trim();
    this.teardown();
    this.phase = "idle";
    this.status = "";
    this.interim = "";
    this.level = 0;

    if (leftover.split(/\s+/).filter(Boolean).length >= 3) {
      this.buffer = "";
      this.detect([leftover]);
    } else {
      this.publish();
    }
  }

  /** Full shutdown, including in-flight answers. Called on unmount. */
  dispose() {
    this.disposed = true;
    this.teardown();
    this.abort?.abort();
    this.abort = null;
    this.queue = [];
    this.parked = [];
    this.draining = false;
  }

  private teardown() {
    this.active = false;

    if (this.chunkTimer !== null) { clearTimeout(this.chunkTimer); this.chunkTimer = null; }
    if (this.watchTimer !== null) { clearInterval(this.watchTimer); this.watchTimer = null; }

    if (this.recorder) {
      // Detach handlers first so the final `onstop` can't restart the loop.
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      try { if (this.recorder.state !== "inactive") this.recorder.stop(); } catch { /* already stopped */ }
      this.recorder = null;
    }

    // Tear down Deepgram real-time streaming
    if (this.dgProcessor) {
      try { this.dgProcessor.disconnect(); } catch { /* already disconnected */ }
      this.dgProcessor = null;
    }
    if (this.dgCtx) {
      void this.dgCtx.close().catch(() => {});
      this.dgCtx = null;
    }
    if (this.dgWs) {
      try {
        if (this.dgWs.readyState === WebSocket.OPEN) {
          this.dgWs.send(JSON.stringify({ type: "CloseStream" }));
          this.dgWs.close();
        }
      } catch { /* already closed */ }
      this.dgWs = null;
    }

    this.stopMeter?.();
    this.stopMeter = null;

    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  // ══ transcription ═════════════════════════════════════════════════════════

  /** Record one chunk, then immediately start the next — capture never pauses. */
  private recordNextChunk() {
    if (!this.active || !this.stream) return;

    const mimeType = pickRecorderMime();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    } catch (err: any) {
      this.error = `This system can't record audio: ${err?.message || "MediaRecorder unavailable"}.`;
      this.stop();
      return;
    }

    this.recorder = recorder;
    const parts: Blob[] = [];

    recorder.ondataavailable = (e) => { if (e.data.size > 0) parts.push(e.data); };
    recorder.onstop = () => {
      const type = mimeType || "audio/webm";
      if (parts.length) this.transcribe(new Blob(parts, { type }), type);
      if (this.active) this.recordNextChunk();
    };

    try {
      recorder.start();
    } catch (err: any) {
      this.error = `Couldn't start recording: ${err?.message || "unknown error"}.`;
      this.stop();
      return;
    }

    this.chunkTimer = window.setTimeout(() => {
      try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* raced with teardown */ }
    }, CHUNK_MS);
  }

  private transcribe(blob: Blob, mimeType: string) {
    this.sttChain = this.sttChain.then(async () => {
      if (!this.active) return;
      try {
        const base64 = await blobToBase64(blob);
        if (!this.active) return;

        const data = await postJson("/api/transcribe-only", { audio: base64, mimeType }, 30000);
        if (!this.active) return;

        if (data.warning) {
          this.warning = data.warning;
          this.publish();
        }

        const text = String(data.transcript || "").trim();
        // Whisper-style loops on near-silence — drop exact repeats.
        if (!text || text === this.lastChunkText) return;

        this.lastChunkText = text;
        if (this.warning) this.warning = "";
        this.ingest(text);
      } catch (err: any) {
        // One dropped chunk must never end the session.
        console.warn("[Auralis] chunk transcription failed:", err?.message || err);
      }
    });
  }

  private ingest(text: string) {
    this.buffer = `${this.buffer} ${text}`.replace(/\s+/g, " ").trim();
    this.lastHeardAt = performance.now();
    this.interim = this.buffer;
    this.status = "Hearing the interviewer…";
    this.publish();
  }

  // == Deepgram real-time streaming ==========================================

  /**
   * Open a WebSocket to the local /ws/deepgram proxy. The proxy authenticates
   * with Deepgram using the server's DEEPGRAM_API_KEY and forwards raw PCM
   * frames. Interim results show as a live preview; final results commit to
   * the rolling buffer and trigger the endpoint-detection watcher.
   *
   * On any connection failure the engine falls back to the chunked
   * MediaRecorder path so the session never silently stalls.
   */
  private startDeepgramStream() {
    if (!this.stream) return;
    try {
      const port = window.location.port || "3000";
      const wsUrl = `ws://localhost:${port}/ws/deepgram`;
      const ws = new WebSocket(wsUrl);
      this.dgWs = ws;

      ws.onopen = () => {
        // Protocol frame — the Deepgram key is read from the server .env.
        ws.send(JSON.stringify({ type: "auth" }));
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data as string);

          if (data.type === "ready") {
            this.startPCMCapture(ws);
            return;
          }

          if (data.type === "error") {
            this.warning = `${data.message}. Falling back to standard transcription.`;
            this.publish();
            this.dgWs = null;
            ws.close();
            this.recordNextChunk();
            return;
          }

          // Deepgram transcript event
          // Shape: { channel: { alternatives: [{ transcript }] }, is_final }
          const transcript: string = (data?.channel?.alternatives?.[0]?.transcript ?? "").trim();
          const isFinal: boolean = Boolean(data?.is_final);
          if (!transcript) return;

          if (isFinal) {
            this.ingest(transcript);
          } else {
            this.lastHeardAt = performance.now();
            this.interim = `${this.buffer} ${transcript}`.trim();
            this.status = "Hearing the interviewer…";
            this.publish();
          }
        } catch { /* malformed JSON — ignore keep-alives */ }
      };

      ws.onerror = () => {
        if (this.dgWs === ws) {
          this.warning = "Deepgram connection failed — using standard transcription.";
          this.publish();
          this.dgWs = null;
          this.recordNextChunk();
        }
      };

      ws.onclose = () => {
        if (this.active && this.dgWs === ws) {
          this.dgWs = null;
          this.recordNextChunk();
        }
      };
    } catch {
      this.recordNextChunk();
    }
  }

  /**
   * Tap the live audio stream, convert float32 samples to int16 PCM, and send
   * frames over the Deepgram WebSocket connection.
   */
  private startPCMCapture(ws: WebSocket) {
    if (!this.stream) return;
    const Ctx: typeof AudioContext =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) { ws.close(); this.recordNextChunk(); return; }

    // Deepgram expects 16 kHz mono linear16 PCM
    const ctx = new Ctx({ sampleRate: 16000 });
    const source = ctx.createMediaStreamSource(this.stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);

    this.dgCtx = ctx;
    this.dgProcessor = processor;

    source.connect(processor);
    processor.connect(ctx.destination);

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (ws.readyState !== WebSocket.OPEN || !this.active) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
      }
      ws.send(int16.buffer);
    };
  }

  // ══ endpoint detection ════════════════════════════════════════════════════

  private startWatcher() {
    this.watchTimer = window.setInterval(() => {
      if (!this.active || this.segmenting) return;

      const buf = this.buffer.trim();
      if (!buf) return;

      const words = buf.split(/\s+/).length;
      if (words < 3) return;

      const quietFor = performance.now() - this.lastHeardAt;
      const finishedSentence = /[?.!]\s*$/.test(buf);

      if (quietFor > SILENCE_MS || (finishedSentence && quietFor > 400) || words > MAX_BUFFER_WORDS) {
        void this.segment();
      }
    }, WATCH_MS);
  }

  /** Crystallise whatever is in the buffer right now ("Answer now" affordance). */
  answerNow() {
    const buf = this.buffer.trim();
    if (!buf) return;
    this.buffer = "";
    this.interim = "";
    this.detect([buf]);
  }

  private async segment() {
    const buf = this.buffer.trim();
    if (!buf) return;

    this.segmenting = true;
    try {
      const data = await postJson("/api/segment-questions", {
        buffer: buf,
        role: this.context.role,
        apiConfig: this.apiConfig,
      }, 20000);

      const questions: string[] = Array.isArray(data.questions)
        ? data.questions.map((q: unknown) => String(q).trim()).filter(Boolean)
        : [];
      const remainder = typeof data.remainder === "string" ? data.remainder.trim() : "";

      if (questions.length) {
        // Anything the interviewer said while we were segmenting must survive.
        const arrivedSince = this.buffer.trim().startsWith(buf)
          ? this.buffer.trim().slice(buf.length).trim()
          : "";
        this.buffer = [remainder, arrivedSince].filter(Boolean).join(" ").trim();
        this.interim = this.buffer;
        this.detect(questions);
      } else if (remainder) {
        this.lastHeardAt = performance.now();
      }
    } catch (err: any) {
      console.warn("[Auralis] segmentation failed:", err?.message || err);
      // Don't strand the transcript: if it looks finished, crystallise it.
      if (/[?.!]\s*$/.test(buf) && buf.split(/\s+/).length >= 4) {
        this.buffer = "";
        this.interim = "";
        this.detect([buf]);
      } else {
        this.lastHeardAt = performance.now();
      }
    } finally {
      this.segmenting = false;
      this.publish();
    }
  }

  // ══ question chips + answering ════════════════════════════════════════════

  /**
   * Newly detected questions arrive here. They always become chips in the
   * transcript rail; AUTO mode additionally fires the answer immediately.
   */
  private detect(questions: string[]) {
    const fresh = questions.map((q) => q.trim()).filter(Boolean);
    if (!fresh.length) { this.publish(); return; }

    const chips: DetectedQuestion[] = fresh.map((text) => ({
      id: uid(),
      text,
      at: Date.now(),
      state: this.answerMode === "auto" ? "answering" : "detected",
    }));
    this.questions = [...this.questions, ...chips].slice(-MAX_CHIPS);

    if (this.answerMode === "auto") {
      this.enqueue(fresh.map((question) => ({ question, source: "audio" as const })));
    } else {
      this.publish();
    }
  }

  /** MANUAL mode: the user clicked a chip — answer it now. */
  answerChip(id: string) {
    const chip = this.questions.find((q) => q.id === id);
    if (!chip || chip.state === "answering") return;
    chip.state = "answering";
    this.enqueue([{ question: chip.text, source: "audio" }]);
  }

  private markChipsAnswered(question: string) {
    let changed = false;
    this.questions = this.questions.map((q) => {
      if (q.text === question && q.state !== "answered") {
        changed = true;
        return { ...q, state: "answered" };
      }
      return q;
    });
    if (changed) this.publish();
  }

  private enqueue(items: Array<{ question: string; source: TurnSource; screenImage?: string; screenMime?: string }>) {
    if (!items.length) { this.publish(); return; }
    this.queue.push(...items);

    // Barge-in: the interviewer moved on, so stop mid-answer and park the turn.
    if (this.activeTurnId) {
      this.park(this.activeTurnId);
      this.abort?.abort();
    }

    this.publish();
    void this.drain();
  }

  private park(turnId: string) {
    const turn = this.turns.find((t) => t.id === turnId);
    if (!turn) return;
    this.patch(turnId, { status: "interrupted" });
    // Newest interruption resumes first — a genuine stack.
    this.parked.push({ ...turn, status: "interrupted" });
  }

  private patch(id: string, patch: Partial<Turn>) {
    let changed = false;
    this.turns = this.turns.map((t) => {
      if (t.id !== id) return t;
      changed = true;
      return { ...t, ...patch };
    });
    if (changed) this.publish();
  }

  private addTurn(item: { question: string; source: TurnSource; screenImage?: string; screenMime?: string }): Turn {
    const turn: Turn = {
      id: uid(),
      question: item.question,
      answer: "",
      status: "thinking",
      isCoding: item.source === "screen",
      source: item.source,
      screenImage: item.screenImage,
      screenMime: item.screenMime,
      askedAt: Date.now(),
    };
    this.turns = [...this.turns, turn].slice(-MAX_TURNS);
    this.publish();
    return turn;
  }

  /** Single-flight loop: fresh questions first, then parked ones newest-first. */
  private async drain() {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.queue.length || this.parked.length) {
        const next = this.queue.shift();
        if (next !== undefined) {
          await this.answer(this.addTurn(next));
          continue;
        }

        const resumed = this.parked.pop();
        if (!resumed) break;

        // A newer question arrived while we were popping — it wins again.
        if (this.queue.length) { this.parked.push(resumed); continue; }

        this.patch(resumed.id, { status: "thinking", answer: "", error: undefined });
        const turn = this.turns.find((t) => t.id === resumed.id);
        if (turn) await this.answer(turn);
      }
    } finally {
      this.draining = false;
      this.publish();
    }
  }

  private history() {
    return this.turns
      .filter((t) => t.status === "done" && t.answer.trim())
      .slice(-HISTORY_TURNS)
      .map((t) => ({ question: t.question, answer: t.answer.slice(0, 1200) }));
  }

  /**
   * Run one SSE stream into a turn: paint deltas on a cadence, watchdog idle
   * streams, settle the final status. Shared by audio answers and Analyze
   * Screen turns.
   */
  private async runStream(turn: Turn, start: StreamStarter) {
    const id = turn.id;
    this.activeTurnId = id;

    const ac = new AbortController();
    this.abort = ac;

    let pending = "";
    let streamError = "";
    let lastByteAt = performance.now();

    const paint = () => {
      if (!pending) return;
      const chunk = pending;
      pending = "";
      const current = this.turns.find((t) => t.id === id);
      if (!current) return;
      this.patch(id, { answer: current.answer + chunk, status: "streaming" });
    };

    this.paintTimer = window.setInterval(paint, PAINT_MS);

    const stall = window.setInterval(() => {
      if (performance.now() - lastByteAt > STALL_MS) ac.abort();
    }, 2000);

    try {
      await start(
        {
          onActivity: () => { lastByteAt = performance.now(); },
          onMeta: (meta) => {
            if (meta.model && meta.model !== this.model) {
              this.model = meta.model;
              this.publish();
            }
            if (typeof meta.isCoding === "boolean" || meta.model) {
              this.patch(id, {
                isCoding: meta.isCoding ?? this.turns.find((t) => t.id === id)?.isCoding ?? false,
                model: meta.model,
              });
            }
          },
          onDelta: (delta) => { pending += delta; },
          onError: (message) => { streamError = message; },
        },
        ac.signal,
      );

      paint();

      const finished = this.turns.find((t) => t.id === id);
      if (streamError && !finished?.answer.trim()) {
        this.patch(id, { status: "error", error: streamError });
      } else if (!finished?.answer.trim()) {
        this.patch(id, { status: "error", error: "The model returned an empty answer. Tap retry." });
      } else {
        this.patch(id, { status: "done", error: streamError || undefined });
      }
    } catch (err: any) {
      // Paint whatever arrived before the abort so partial answers stay readable.
      paint();

      if (ac.signal.aborted) {
        const parkedTurn = this.turns.find((t) => t.id === id);
        if (parkedTurn && parkedTurn.status !== "interrupted") {
          this.patch(id, { status: "error", error: "The answer stalled. Tap retry." });
        }
      } else {
        this.patch(id, { status: "error", error: err?.message || "The answer failed." });
      }
    } finally {
      clearInterval(stall);
      if (this.paintTimer !== null) { clearInterval(this.paintTimer); this.paintTimer = null; }
      if (this.activeTurnId === id) this.activeTurnId = null;
      if (this.abort === ac) this.abort = null;
    }

    const settled = this.turns.find((t) => t.id === id);
    if (settled?.status === "done") this.markChipsAnswered(settled.question);
  }

  private answer(turn: Turn) {
    // Screen turns re-run the vision pipeline (park/resume, regenerate).
    if (turn.source === "screen" && turn.screenImage) {
      const image = turn.screenImage;
      const mimeType = turn.screenMime || "image/png";
      return this.runStream(turn, (handlers, signal) =>
        streamScreenAnalysis(
          {
            image,
            mimeType,
            question: turn.question,
            history: this.history(),
            apiConfig: this.apiConfig,
            ...this.context,
          },
          handlers,
          signal,
        ),
      );
    }
    return this.runStream(turn, (handlers, signal) =>
      streamAnswer(
        {
          question: turn.question,
          history: this.history(),
          apiConfig: this.apiConfig,
          ...this.context,
        },
        handlers,
        signal,
      ),
    );
  }

  /**
   * Analyze Screen: streams a vision-model solution into a chat turn. Routed
   * through the same single-flight queue so it barges in like any answer.
   */
  analyzeScreen(image: string, mimeType: string, question?: string) {
    this.enqueue([{
      question: question?.trim() || "Analyze the problem on screen",
      source: "screen",
      screenImage: image,
      screenMime: mimeType,
    }]);
  }

  /** Re-answer one turn (retry / regenerate). */
  retry(id: string) {
    const turn = this.turns.find((t) => t.id === id);
    if (!turn) return;

    // Drop any stale park entry so it can't be answered twice.
    this.parked = this.parked.filter((t) => t.id !== id);
    this.patch(id, { answer: "", status: "queued", error: undefined });

    // Route it through the stack so the single-flight guarantee still holds.
    this.parked.push({ ...turn, answer: "", status: "interrupted", error: undefined });
    if (this.activeTurnId) {
      this.park(this.activeTurnId);
      this.abort?.abort();
    }
    this.publish();
    void this.drain();
  }

  /** Surface a recoverable problem in the banner (capture errors, etc). */
  notify(message: string) {
    this.warning = message;
    this.publish();
  }

  /** Ask a typed question directly, bypassing audio. */
  ask(question: string) {
    const q = question.trim();
    if (q) this.enqueue([{ question: q, source: "manual" }]);
  }

  /** The completed Q&A pairs — used for AI Notes and session history. */
  completedTurns() {
    return this.turns
      .filter((t) => t.status === "done" && t.answer.trim())
      .map((t) => ({ question: t.question, answer: t.answer }));
  }

  clear() {
    if (this.activeTurnId) return;
    this.turns = [];
    this.parked = [];
    this.questions = [];
    this.publish();
  }
}
