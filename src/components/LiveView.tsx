/**
 * LiveView — the live interview copilot screen.
 *
 * Left: transcript rail (interim speech + question chips). Right: streaming
 * Q&A card feed. Bottom: command bar (AUTO/MANUAL, manual ask, Analyze Screen,
 * source indicator, End Session). The split is draggable and collapses to a
 * stacked layout under 640px (CSS).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  Copy,
  Hexagon,
  ImagePlay,
  Loader2,
  Mic,
  Monitor,
  RefreshCw,
  ScanSearch,
  Send,
  Square,
} from "lucide-react";
import { LiveEngine, type EngineState } from "../live/engine";
import { toPlainText } from "../live/markdown";
import type { ApiConfig, SessionConfig } from "../types";
import type { DetectedQuestion, Turn } from "../live/types";
import AnswerBody from "./AnswerBody";

interface LiveViewProps {
  session: SessionConfig;
  apiConfig: ApiConfig;
  onEndSession: (turns: { question: string; answer: string }[]) => void;
  /** Mirrors engine state up (drives the compact-mode latest-answer strip). */
  onEngineState?: (state: EngineState) => void;
}

const METER_BARS = 12;
const SPLIT_KEY = "auralis_split_pct";

const initialState: EngineState = {
  phase: "idle",
  mode: "system",
  answerMode: "auto",
  turns: [],
  questions: [],
  interim: "",
  level: 0,
  status: "",
  error: "",
  warning: "",
  pending: 0,
  model: "",
};

const STATUS_LABEL: Record<Turn["status"], string> = {
  queued: "queued",
  thinking: "answering",
  streaming: "answering",
  done: "done",
  interrupted: "paused",
  error: "failed",
};

function chipTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function LiveView({ session, apiConfig, onEndSession, onEngineState }: LiveViewProps) {
  const [state, setState] = useState<EngineState>(initialState);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [split, setSplit] = useState(() => {
    const raw = Number(localStorage.getItem(SPLIT_KEY));
    return raw >= 25 && raw <= 55 ? raw : 38;
  });
  const [pinned, setPinned] = useState(true);

  const engineRef = useRef<LiveEngine | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const splitRef = useRef(split);
  splitRef.current = split;

  const context = useMemo(() => ({
    role: session.position,
    company: session.company,
    resumeText: session.resumeText,
    extraContext: session.extraContext,
    language: session.language,
  }), [session]);

  // One engine per live session; started immediately with the chosen source.
  useEffect(() => {
    const emit = (s: EngineState) => { setState(s); onEngineState?.(s); };
    const engine = new LiveEngine(apiConfig, context, emit);
    engineRef.current = engine;
    void engine.start(session.audioSource);
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.update(apiConfig, context);
  }, [apiConfig, context]);

  // Global Ctrl+Shift+A hotkey → Analyze Screen.
  useEffect(() => {
    const api = window.electronOverlay;
    if (!api?.onAnalyzeScreen) return;
    return api.onAnalyzeScreen(() => { void analyzeScreen(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll: follow the stream until the user scrolls up.
  const onFeedScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const p = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinnedRef.current = p;
    setPinned(p);
  };

  useEffect(() => {
    const el = feedRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [state.turns]);

  // Rail follows new chips/interim.
  useEffect(() => {
    const el = railRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.questions, state.interim]);

  const engine = () => engineRef.current;

  const analyzeScreen = useCallback(async () => {
    const api = window.electronOverlay;
    if (!api?.captureScreen || capturing) return;
    setCapturing(true);
    try {
      const shot = await api.captureScreen();
      if (shot.error || !shot.image) {
        engine()?.notify(shot.error || "Screen capture failed.");
        return;
      }
      engine()?.analyzeScreen(shot.image, shot.mimeType || "image/png", draft.trim() || undefined);
      setDraft("");
    } finally {
      setCapturing(false);
    }
  }, [capturing, draft]);

  const copyTurn = async (turn: Turn) => {
    try {
      await navigator.clipboard.writeText(toPlainText(turn.answer));
      setCopiedId(turn.id);
      window.setTimeout(() => setCopiedId(null), 1800);
    } catch { /* clipboard blocked */ }
  };

  const submitDraft = (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = draft.trim();
    if (!q) return;
    engine()?.ask(q);
    setDraft("");
  };

  // Draggable split divider.
  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(55, Math.max(25, pct));
      setSplit(Math.round(clamped * 10) / 10);
    };
    const up = () => {
      localStorage.setItem(SPLIT_KEY, String(splitRef.current));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const handleEnd = () => {
    const turns = engine()?.completedTurns() ?? [];
    engine()?.stop();
    onEndSession(turns);
  };

  const waitingChips = state.questions.filter((q) => q.state === "detected").length;
  const level = Math.min(100, state.level);

  return (
    <div className="live-root">
      {(state.warning || state.error) && (
        <div className={"live-banner" + (state.error ? " error" : "")}>
          <AlertTriangle size={12} />
          <span>{state.error || state.warning}</span>
          {state.error && (
            <button type="button" className="live-banner-fix" onClick={() => void engine()?.start(state.mode)}>
              Retry
            </button>
          )}
        </div>
      )}

      <div className="live-split" style={{ ["--split" as any]: `${split}%` }}>
        {/* ── LEFT: transcript rail ─────────────────────────────────────── */}
        <section className="rail glass-panel" aria-label="Live transcript">
          <header className="rail-head">
            <span className="micro-label">Live transcript</span>
            <div className="rail-meter" aria-hidden>
              {Array.from({ length: METER_BARS }).map((_, i) => (
                <span
                  key={i}
                  className="rail-meter-bar"
                  style={{ height: `${Math.max(15, level * Math.max(0.15, 1 - Math.abs(i - METER_BARS / 2) / METER_BARS))}%` }}
                />
              ))}
            </div>
          </header>

          <div className="rail-body" ref={railRef}>
            {state.questions.length === 0 && !state.interim && (
              <div className="rail-empty">
                <Hexagon size={30} strokeWidth={1} />
                <p>Listening for questions…</p>
              </div>
            )}

            <AnimatePresence initial={false}>
              {state.questions.map((q: DetectedQuestion) => (
                <motion.button
                  key={q.id}
                  type="button"
                  className={"q-chip state-" + q.state}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  onClick={() => engine()?.answerChip(q.id)}
                  disabled={q.state === "answering"}
                  title={q.state === "detected" ? "Answer this question" : q.state === "answering" ? "Answering…" : "Re-ask this question"}
                >
                  <span className="q-chip-text">{q.text}</span>
                  <span className="q-chip-meta">
                    <span className="q-chip-ts">{chipTime(q.at)}</span>
                    {q.state === "answering" && <span className="q-chip-answering">answering →</span>}
                    {q.state === "detected" && state.answerMode === "manual" && <span className="q-chip-cta">Answer</span>}
                  </span>
                </motion.button>
              ))}
            </AnimatePresence>

            {state.interim && (
              <p className="rail-interim">{state.interim}</p>
            )}
          </div>
        </section>

        {/* ── divider ────────────────────────────────────────────────────── */}
        <div className="live-divider" onPointerDown={onDividerDown} role="separator" aria-orientation="vertical" />

        {/* ── RIGHT: answers feed ───────────────────────────────────────── */}
        <section className="feed glass-panel" aria-label="Answers">
          <div className="feed-scroll" ref={feedRef} onScroll={onFeedScroll}>
            {state.turns.length === 0 ? (
              <div className="feed-empty">
                <Hexagon size={34} strokeWidth={1} />
                <p>Answers will appear here</p>
                <span>{state.answerMode === "auto" ? "Every detected question is answered instantly." : "Click a question chip on the left to answer it."}</span>
              </div>
            ) : (
              state.turns.map((turn) => {
                const settled = turn.status === "done" || turn.status === "error";
                const waiting = (turn.status === "thinking" || turn.status === "queued") && !turn.answer;
                const streaming = turn.status === "streaming" || turn.status === "thinking";
                return (
                  <motion.article
                    key={turn.id}
                    className={"qa-card" + (streaming ? " streaming" : "") + (turn.status === "error" ? " failed" : "")}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                  >
                    <header className="qa-head">
                      <h3 className="qa-question">{turn.question}</h3>
                      <div className="qa-head-right">
                        {turn.source === "screen" && (
                          <span className="qa-badge vision"><ImagePlay size={9} /> screen</span>
                        )}
                        <span className={"qa-badge st-" + turn.status}>{STATUS_LABEL[turn.status]}</span>
                      </div>
                    </header>

                    {waiting ? (
                      <p className="qa-waiting">
                        <Loader2 size={12} className="spin" />
                        {turn.status === "queued" ? " Waiting for the current answer…" : " Working out the answer…"}
                      </p>
                    ) : (
                      <AnswerBody markdown={turn.answer} />
                    )}

                    {turn.status === "interrupted" && (
                      <p className="qa-note">Paused — a newer question came in. Resuming next.</p>
                    )}
                    {turn.error && (
                      <div className="qa-error">
                        <AlertTriangle size={11} />
                        <span>{turn.error}</span>
                        <button type="button" onClick={() => engine()?.retry(turn.id)}>Retry</button>
                      </div>
                    )}

                    {settled && turn.answer.trim() && (
                      <footer className="qa-actions">
                        <button type="button" className="qa-action" onClick={() => copyTurn(turn)}>
                          {copiedId === turn.id ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
                        </button>
                        <button type="button" className="qa-action" onClick={() => engine()?.retry(turn.id)}>
                          <RefreshCw size={11} /> Regenerate
                        </button>
                      </footer>
                    )}
                  </motion.article>
                );
              })
            )}
          </div>

          {!pinned && (
            <button
              type="button"
              className="feed-repin"
              onClick={() => {
                pinnedRef.current = true;
                setPinned(true);
                const el = feedRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
            >
              <ArrowDown size={11} /> live
            </button>
          )}
        </section>
      </div>

      {/* ── COMMAND BAR ─────────────────────────────────────────────────── */}
      <footer className="cmd-bar glass-panel">
        <div className="seg-control cmd-mode">
          <button
            type="button"
            className={"seg-item" + (state.answerMode === "auto" ? " active" : "")}
            onClick={() => engine()?.setAnswerMode("auto")}
          >
            Auto
          </button>
          <button
            type="button"
            className={"seg-item" + (state.answerMode === "manual" ? " active" : "")}
            onClick={() => engine()?.setAnswerMode("manual")}
          >
            Manual{waitingChips > 0 ? ` (${waitingChips})` : ""}
          </button>
        </div>

        <form className="cmd-ask" onSubmit={submitDraft}>
          <textarea
            className="cmd-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitDraft();
              }
            }}
            placeholder="Ask anything…"
            rows={1}
            aria-label="Ask a question directly"
          />
          <button type="submit" className="cmd-send" disabled={!draft.trim()} title="Ask" aria-label="Ask">
            <Send size={13} />
          </button>
        </form>

        <button
          type="button"
          className="btn-ghost cmd-screen"
          onClick={() => void analyzeScreen()}
          disabled={capturing}
          title="Analyze Screen (Ctrl+Shift+A)"
        >
          {capturing ? <Loader2 size={13} className="spin" /> : <ScanSearch size={13} />}
          Analyze Screen
        </button>

        <span className="cmd-source" title={state.mode === "system" ? "System audio" : "Microphone"}>
          {state.mode === "system" ? <Monitor size={12} /> : <Mic size={12} />}
          {state.status && state.phase !== "idle" && <span className="cmd-status">{state.status}</span>}
        </span>

        <button type="button" className="btn-danger-ghost" onClick={handleEnd}>
          <Square size={11} /> End Session
        </button>
      </footer>
    </div>
  );
}
