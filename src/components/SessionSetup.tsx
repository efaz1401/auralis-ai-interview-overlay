/**
 * SessionSetup — the pre-live configuration panel: position, company, resume,
 * answer language, provider+model, audio source. Footer has recent sessions
 * (click = prefill) and the Go Live button.
 */

import React, { useState } from "react";
import { motion } from "motion/react";
import { ChevronDown, FileText, Mic, Monitor, Radio, Settings2 } from "lucide-react";
import {
  ANSWER_LANGUAGES,
  DEFAULT_MODEL,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  type AiProvider,
  type ApiConfig,
  type SessionConfig,
  type SessionRecord,
} from "../types";

interface SessionSetupProps {
  session: SessionConfig;
  apiConfig: ApiConfig;
  recents: SessionRecord[];
  onChange: (session: SessionConfig) => void;
  onApiChange: (config: ApiConfig) => void;
  onGoLive: () => void;
  onOpenSettings: () => void;
}

const PROVIDERS: AiProvider[] = ["openai", "groq", "grok"];

export default function SessionSetup({
  session,
  apiConfig,
  recents,
  onChange,
  onApiChange,
  onGoLive,
  onOpenSettings,
}: SessionSetupProps) {
  const [showExtra, setShowExtra] = useState(Boolean(session.extraContext));

  const set = <K extends keyof SessionConfig>(key: K, value: SessionConfig[K]) =>
    onChange({ ...session, [key]: value });

  const setProvider = (provider: AiProvider) => {
    onApiChange({ ...apiConfig, provider, model: DEFAULT_MODEL[provider] });
  };

  const keysFor = (p: AiProvider) =>
    (p === "openai" ? apiConfig.openaiKeys : p === "groq" ? apiConfig.groqKeys : apiConfig.grokKeys)
      .split(",").map((k) => k.trim()).filter(Boolean).length;

  return (
    <div className="setup-wrap">
      <motion.div
        className="setup-panel glass-panel"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <div className="setup-head">
          <div>
            <h1 className="screen-title">Session setup</h1>
            <p className="setup-sub">Tune the copilot before you go live.</p>
          </div>
          <button type="button" className="btn-ghost" onClick={onOpenSettings} title="API keys & defaults">
            <Settings2 size={14} /> Settings
          </button>
        </div>

        <div className="setup-body">
          <div className="setup-grid">
            <label className="field">
              <span className="field-label">Position</span>
              <input
                className="field-input"
                value={session.position}
                onChange={(e) => set("position", e.target.value)}
                placeholder="Senior Frontend Engineer"
              />
            </label>
            <label className="field">
              <span className="field-label">Company</span>
              <input
                className="field-input"
                value={session.company}
                onChange={(e) => set("company", e.target.value)}
                placeholder="Stripe"
              />
            </label>
            <label className="field">
              <span className="field-label">Answer language</span>
              <div className="field-select-wrap">
                <select
                  className="field-input field-select"
                  value={session.language}
                  onChange={(e) => set("language", e.target.value)}
                >
                  {ANSWER_LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
                <ChevronDown size={12} className="field-select-caret" />
              </div>
            </label>

            <div className="field">
              <span className="field-label">Provider</span>
              <div className="seg-control">
                {PROVIDERS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={"seg-item" + (apiConfig.provider === p ? " active" : "")}
                    onClick={() => setProvider(p)}
                  >
                    <span className={"provider-dot dot-" + p} />
                    {PROVIDER_LABELS[p]}
                    {keysFor(p) === 0 && <span className="seg-nokey" title="No API key in Settings">!</span>}
                  </button>
                ))}
              </div>
            </div>

            <div className="field field-span">
              <span className="field-label">Model</span>
              <div className="pill-row">
                {PROVIDER_MODELS[apiConfig.provider].map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={"model-pill" + (apiConfig.model === m ? " active" : "")}
                    onClick={() => onApiChange({ ...apiConfig, model: m })}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div className="field field-span">
              <span className="field-label">Audio source</span>
              <div className="source-tiles">
                <button
                  type="button"
                  className={"source-tile" + (session.audioSource === "system" ? " active" : "")}
                  onClick={() => set("audioSource", "system")}
                >
                  <Monitor size={18} />
                  <span className="source-tile-title">System audio</span>
                  <span className="source-tile-sub">Hears the interviewer</span>
                </button>
                <button
                  type="button"
                  className={"source-tile" + (session.audioSource === "mic" ? " active" : "")}
                  onClick={() => set("audioSource", "mic")}
                >
                  <Mic size={18} />
                  <span className="source-tile-title">Microphone</span>
                  <span className="source-tile-sub">Speakerphone setups</span>
                </button>
              </div>
            </div>

            <label className="field field-span">
              <span className="field-label"><FileText size={10} /> Resume</span>
              <textarea
                className={"field-input field-textarea" + (session.resumeText ? " mono" : "")}
                value={session.resumeText}
                onChange={(e) => set("resumeText", e.target.value)}
                placeholder="Paste your resume — answers are grounded in your real background."
                rows={5}
              />
            </label>

            <div className="field field-span">
              <button
                type="button"
                className="extra-toggle"
                onClick={() => setShowExtra((v) => !v)}
              >
                <ChevronDown size={11} className={"extra-caret" + (showExtra ? " open" : "")} />
                Extra context
              </button>
              {showExtra && (
                <textarea
                  className="field-input field-textarea"
                  value={session.extraContext}
                  onChange={(e) => set("extraContext", e.target.value)}
                  placeholder="Anything else: the team, the tech stack, topics they said they'd cover…"
                  rows={3}
                />
              )}
            </div>
          </div>
        </div>

        <div className="setup-footer">
          <div className="setup-recents">
            {recents.slice(0, 4).map((r) => (
              <button
                key={r.id}
                type="button"
                className="recent-pill"
                title={`Prefill from ${new Date(r.endedAt).toLocaleDateString()}`}
                onClick={() => onChange({ ...session, position: r.position, company: r.company })}
              >
                {r.position || "Session"}{r.company ? ` · ${r.company}` : ""}
              </button>
            ))}
          </div>
          <button type="button" className="btn-primary" onClick={onGoLive}>
            <Radio size={14} /> Go Live
          </button>
        </div>
      </motion.div>
    </div>
  );
}
