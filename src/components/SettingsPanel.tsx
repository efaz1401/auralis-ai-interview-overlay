/**
 * SettingsPanel — frosted slide-over from the right (not a separate screen).
 * Providers & keys (OpenAI / Groq / Grok only), Defaults, Appearance (the two
 * alpha sliders + font scale), and access-key status with a Lock button.
 * Deepgram is STT-only and lives in the server .env — it is NOT here.
 */

import React, { useEffect } from "react";
import { motion } from "motion/react";
import { LockKeyhole, X } from "lucide-react";
import { gateStatus } from "../auth/gate";
import {
  DEFAULT_MODEL,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  ANSWER_LANGUAGES,
  type AiProvider,
  type ApiConfig,
  type FontScale,
} from "../types";

interface SettingsPanelProps {
  apiConfig: ApiConfig;
  onApiChange: (config: ApiConfig) => void;
  language: string;
  onLanguageChange: (language: string) => void;
  glassAlpha: number;
  textAlpha: number;
  onAlphaChange: (kind: "glass" | "text", value: number) => void;
  fontScale: FontScale;
  onFontScale: (scale: FontScale) => void;
  onLock: () => void;
  onClose: () => void;
}

const PROVIDERS: AiProvider[] = ["openai", "groq", "grok"];

function keysOf(config: ApiConfig, p: AiProvider): string {
  return p === "openai" ? config.openaiKeys : p === "groq" ? config.groqKeys : config.grokKeys;
}

function maskKeys(raw: string): string {
  return raw
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => (k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "••••"))
    .join(", ");
}

export default function SettingsPanel(props: SettingsPanelProps) {
  const { apiConfig, onApiChange, onClose } = props;
  const gate = gateStatus();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setKeys = (p: AiProvider, value: string) => {
    if (p === "openai") onApiChange({ ...apiConfig, openaiKeys: value });
    else if (p === "groq") onApiChange({ ...apiConfig, groqKeys: value });
    else onApiChange({ ...apiConfig, grokKeys: value });
  };

  return (
    <>
      <motion.div
        className="settings-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22 }}
        onClick={onClose}
      />
      <motion.aside
        className="settings-panel glass-panel"
        initial={{ opacity: 0, x: 32 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 32 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        role="dialog"
        aria-label="Settings"
      >
        <header className="settings-head">
          <h2 className="screen-title">Settings</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close settings">
            <X size={14} />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h3 className="micro-label">Providers & keys</h3>
            <p className="settings-hint">Paste one or more keys per provider, comma-separated. Extra keys rotate automatically on rate limits.</p>
            {PROVIDERS.map((p) => (
              <div key={p} className="key-card">
                <div className="key-card-head">
                  <span className={"provider-dot dot-" + p} />
                  <span className="key-card-name">{PROVIDER_LABELS[p]}</span>
                  {keysOf(apiConfig, p).trim() ? (
                    <span className="key-card-count">{maskKeys(keysOf(apiConfig, p))}</span>
                  ) : (
                    <span className="key-card-count none">no key</span>
                  )}
                </div>
                <textarea
                  className="field-input field-textarea mono key-card-input"
                  value={keysOf(apiConfig, p)}
                  onChange={(e) => setKeys(p, e.target.value)}
                  placeholder={p === "openai" ? "sk-…" : p === "groq" ? "gsk_…" : "xai-…"}
                  rows={2}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ))}
          </section>

          <section className="settings-section">
            <h3 className="micro-label">Defaults</h3>
            <label className="field">
              <span className="field-label">Answer language</span>
              <select
                className="field-input field-select"
                value={props.language}
                onChange={(e) => props.onLanguageChange(e.target.value)}
              >
                {ANSWER_LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <div className="field">
              <span className="field-label">Default model per provider</span>
              {PROVIDERS.map((p) => (
                <div key={p} className="pill-row settings-model-row">
                  <span className="settings-model-label">{PROVIDER_LABELS[p]}</span>
                  {PROVIDER_MODELS[p].map((m) => (
                    <span key={m} className={"model-pill static" + (DEFAULT_MODEL[p] === m ? " active" : "")}>{m}</span>
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h3 className="micro-label">Appearance</h3>
            <div className="appearance-sliders">
              <label className="alpha-row">
                <span className="field-label">Panels</span>
                <input
                  type="range"
                  min={0.15}
                  max={1}
                  step={0.05}
                  value={props.glassAlpha}
                  onChange={(e) => props.onAlphaChange("glass", Number(e.target.value))}
                  aria-label="Panel opacity"
                />
                <span className="alpha-value">{Math.round(props.glassAlpha * 100)}%</span>
              </label>
              <label className="alpha-row">
                <span className="field-label">Text</span>
                <input
                  type="range"
                  min={0.3}
                  max={1}
                  step={0.05}
                  value={props.textAlpha}
                  onChange={(e) => props.onAlphaChange("text", Number(e.target.value))}
                  aria-label="Text opacity"
                />
                <span className="alpha-value">{Math.round(props.textAlpha * 100)}%</span>
              </label>
            </div>
            <div className="appearance-preview">
              <span className="appearance-swatch" />
              <span className="appearance-sample">The quick brown fox — 0123</span>
            </div>
            <div className="field">
              <span className="field-label">Font size</span>
              <div className="seg-control">
                {(["S", "M", "L"] as FontScale[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={"seg-item" + (props.fontScale === s ? " active" : "")}
                    onClick={() => props.onFontScale(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="micro-label">Access key</h3>
            {gate ? (
              <div className="gate-status">
                <div className="gate-status-row"><span>Key</span><code>{gate.key.replace(/^(AUR-).{4}-.{4}-(.{4})$/, "$1••••-••••-$2")}</code></div>
                {gate.label && <div className="gate-status-row"><span>Label</span><span>{gate.label}</span></div>}
                <div className="gate-status-row"><span>Expires</span><span>{gate.expiresAt ? new Date(gate.expiresAt).toLocaleDateString() : "never"}</span></div>
                <div className="gate-status-row"><span>Devices</span><span>{gate.devices ?? 1}{gate.maxDevices ? ` / ${gate.maxDevices}` : ""}</span></div>
                <button type="button" className="btn-danger-ghost gate-lock-btn" onClick={props.onLock}>
                  <LockKeyhole size={12} /> Lock app
                </button>
              </div>
            ) : (
              <p className="settings-hint">No key information available.</p>
            )}
          </section>
        </div>
      </motion.aside>
    </>
  );
}
