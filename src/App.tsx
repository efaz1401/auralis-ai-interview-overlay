/**
 * Auralis — live interview copilot overlay.
 *
 * Flow: KeyGate → Session Setup → Live view → AI Notes. A Supabase-backed
 * access key gates the whole app (re-validated every 30 min, 12h offline
 * grace, locked instantly on revoke/expiry). All visible opacity is driven by
 * two CSS variables (--glass-alpha / --text-alpha) controlled from the top
 * bar sliders, Settings, or global hotkeys.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import OverlayControls from "./components/OverlayControls";
import KeyGate from "./components/KeyGate";
import SessionSetup from "./components/SessionSetup";
import LiveView from "./components/LiveView";
import NotesView from "./components/NotesView";
import SettingsPanel from "./components/SettingsPanel";
import CompactStrip from "./components/CompactStrip";
import type { EngineState } from "./live/engine";
import { cachedKey, clearGate, revalidate, type GateResult } from "./auth/gate";
import {
  DEFAULT_API_CONFIG,
  DEFAULT_SESSION,
  PROVIDER_MODELS,
  type ApiConfig,
  type FontScale,
  type SessionConfig,
  type SessionRecord,
} from "./types";

const STORAGE_API = "auralis_api_config_v2";
const STORAGE_SESSION = "auralis_session_v1";
const STORAGE_HISTORY = "auralis_sessions_v1";
const STORAGE_GLASS = "auralis_glass_alpha";
const STORAGE_TEXT = "auralis_text_alpha";
const STORAGE_FONT = "auralis_font_scale";

const REVALIDATE_MS = 30 * 60 * 1000; // 30 minutes

const FONT_SCALES: Record<FontScale, number> = { S: 0.92, M: 1, L: 1.12 };

type Screen = "setup" | "live" | "notes";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function loadNumber(key: string, fallback: number): number {
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default function App() {
  // ── access gate ───────────────────────────────────────────────────────────
  const [gate, setGate] = useState<{ state: "locked" | "unlocked"; reason?: GateResult["reason"] }>({ state: "locked" });

  // ── app state ─────────────────────────────────────────────────────────────
  const [screen, setScreen] = useState<Screen>("setup");
  const [session, setSession] = useState<SessionConfig>(() => loadJson(STORAGE_SESSION, DEFAULT_SESSION));
  const [apiConfig, setApiConfig] = useState<ApiConfig>(() => {
    const cfg = loadJson(STORAGE_API, DEFAULT_API_CONFIG);
    if (!PROVIDER_MODELS[cfg.provider]?.includes(cfg.model)) {
      return { ...DEFAULT_API_CONFIG, ...cfg, provider: "openai", model: DEFAULT_API_CONFIG.model };
    }
    return cfg;
  });
  const [history, setHistory] = useState<SessionRecord[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_HISTORY) || "[]"); } catch { return []; }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [liveTurns, setLiveTurns] = useState<{ question: string; answer: string }[]>([]);
  const [liveStartedAt, setLiveStartedAt] = useState(0);
  const [engineState, setEngineState] = useState<EngineState | null>(null);
  const [isCompact, setIsCompact] = useState(false);

  // ── Glacier appearance ────────────────────────────────────────────────────
  const [glassAlpha, setGlassAlpha] = useState(() => loadNumber(STORAGE_GLASS, 0.75));
  const [textAlpha, setTextAlpha] = useState(() => loadNumber(STORAGE_TEXT, 1));
  const [fontScale, setFontScale] = useState<FontScale>(() => {
    const s = localStorage.getItem(STORAGE_FONT);
    return s === "S" || s === "L" ? s : "M";
  });

  const applyAlpha = useCallback((kind: "glass" | "text", value: number) => {
    const clamped = Math.round(value * 100) / 100;
    if (kind === "glass") {
      const v = Math.min(1, Math.max(0.15, clamped));
      setGlassAlpha(v);
      document.documentElement.style.setProperty("--glass-alpha", String(v));
      localStorage.setItem(STORAGE_GLASS, String(v));
    } else {
      const v = Math.min(1, Math.max(0.3, clamped));
      setTextAlpha(v);
      document.documentElement.style.setProperty("--text-alpha", String(v));
      localStorage.setItem(STORAGE_TEXT, String(v));
    }
  }, []);

  // Apply persisted appearance on boot.
  useEffect(() => {
    document.documentElement.style.setProperty("--glass-alpha", String(glassAlpha));
    document.documentElement.style.setProperty("--text-alpha", String(textAlpha));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--font-scale", String(FONT_SCALES[fontScale]));
    localStorage.setItem(STORAGE_FONT, fontScale);
  }, [fontScale]);

  // ── gate: 30-minute heartbeat revalidation ────────────────────────────────
  // (Launch-time silent validation happens inside KeyGate via the cached key.)
  useEffect(() => {
    if (gate.state !== "unlocked") return;
    const timer = window.setInterval(async () => {
      const result = await revalidate();
      if (!result.valid && result.reason !== "service" && !result.offline) {
        clearGate();
        setGate({ state: "locked", reason: result.reason });
        setScreen("setup");
      }
    }, REVALIDATE_MS);
    return () => window.clearInterval(timer);
  }, [gate.state]);

  // ── electron wiring ───────────────────────────────────────────────────────
  useEffect(() => {
    const api = window.electronOverlay;
    if (!api) return;
    document.documentElement.classList.add("is-electron");
    api.getState().then((s) => {
      if (s.glassSupported) document.documentElement.classList.add("glass-real");
      if (typeof s.isCompact === "boolean") setIsCompact(s.isCompact);
    });
    const offState = api.onState((s) => {
      if (typeof s.isCompact === "boolean") {
        setIsCompact(s.isCompact);
        document.documentElement.classList.toggle("compact-mode", s.isCompact);
      }
    });
    const offAlpha = api.onAlphaStep(({ kind, delta }) => {
      applyAlpha(kind, (kind === "glass" ? glassAlpha : textAlpha) + delta);
    });
    return () => { offState(); offAlpha(); };
  }, [applyAlpha, glassAlpha, textAlpha]);

  // ── persistence ───────────────────────────────────────────────────────────
  useEffect(() => {
    try { localStorage.setItem(STORAGE_API, JSON.stringify(apiConfig)); } catch { /* ignore */ }
  }, [apiConfig]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_SESSION, JSON.stringify(session)); } catch { /* ignore */ }
  }, [session]);

  // ── handlers ──────────────────────────────────────────────────────────────
  const handleUnlock = () => setGate({ state: "unlocked" });

  const handleLock = () => {
    clearGate();
    setSettingsOpen(false);
    setScreen("setup");
    setGate({ state: "locked" });
  };

  const handleGoLive = () => {
    setLiveStartedAt(Date.now());
    setScreen("live");
  };

  const handleEndSession = (turns: { question: string; answer: string }[]) => {
    setLiveTurns(turns);
    setScreen("notes");
  };

  const handleSaveSession = (record: SessionRecord) => {
    const next = [record, ...history].slice(0, 20);
    setHistory(next);
    try { localStorage.setItem(STORAGE_HISTORY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const liveActive = screen === "live" && (engineState?.phase === "live" || engineState?.phase === "starting");

  // ── render ────────────────────────────────────────────────────────────────
  if (gate.state !== "unlocked") {
    return (
      <div className="overlay-root">
        <OverlayControls liveActive={false} glassAlpha={glassAlpha} textAlpha={textAlpha} onAlphaChange={applyAlpha} />
        <KeyGate initialKey={cachedKey()} lockReason={gate.reason} onUnlock={handleUnlock} />
      </div>
    );
  }

  return (
    <div className="overlay-root">
      <OverlayControls liveActive={liveActive} glassAlpha={glassAlpha} textAlpha={textAlpha} onAlphaChange={applyAlpha} />

      {/* Full-size screens (hidden in compact mode by CSS) */}
      <div className="screen-area">
        {screen === "setup" && (
          <SessionSetup
            session={session}
            apiConfig={apiConfig}
            recents={history}
            onChange={setSession}
            onApiChange={setApiConfig}
            onGoLive={handleGoLive}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}

        {screen === "live" && (
          <LiveView
            session={session}
            apiConfig={apiConfig}
            onEndSession={handleEndSession}
            onEngineState={setEngineState}
          />
        )}

        {screen === "notes" && (
          <NotesView
            session={session}
            apiConfig={apiConfig}
            turns={liveTurns}
            startedAt={liveStartedAt}
            history={history}
            onSave={handleSaveSession}
            onNewSession={() => setScreen("setup")}
          />
        )}
      </div>

      {/* Compact mode: latest-answer strip only */}
      {isCompact && screen === "live" && <CompactStrip state={engineState} />}

      <AnimatePresence>
        {settingsOpen && (
          <SettingsPanel
            apiConfig={apiConfig}
            onApiChange={setApiConfig}
            language={session.language}
            onLanguageChange={(language) => setSession((s) => ({ ...s, language }))}
            glassAlpha={glassAlpha}
            textAlpha={textAlpha}
            onAlphaChange={applyAlpha}
            fontScale={fontScale}
            onFontScale={setFontScale}
            onLock={handleLock}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
