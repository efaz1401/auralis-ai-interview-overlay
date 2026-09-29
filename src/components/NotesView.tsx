/**
 * NotesView — the AI Notes sheet shown after End Session, plus local history.
 */

import React, { useState } from "react";
import { motion } from "motion/react";
import { Check, Copy, History, Loader2, Plus, Save, Sparkles } from "lucide-react";
import { postJson } from "../live/http";
import type { ApiConfig, SessionConfig, SessionRecord } from "../types";
import AnswerBody from "./AnswerBody";

interface NotesViewProps {
  session: SessionConfig;
  apiConfig: ApiConfig;
  turns: { question: string; answer: string }[];
  startedAt: number;
  history: SessionRecord[];
  onSave: (record: SessionRecord) => void;
  onNewSession: () => void;
}

function fmtDuration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`;
}

export default function NotesView({ session, apiConfig, turns, startedAt, history, onSave, onNewSession }: NotesViewProps) {
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [generated, setGenerated] = useState(false);

  const duration = Date.now() - startedAt;

  const generate = async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const data = await postJson("/api/session-notes", {
        turns,
        role: session.position,
        company: session.company,
        language: session.language,
        apiConfig,
      }, 90000);
      if (data.error) throw new Error(data.error);
      setNotes(String(data.notes || ""));
      setGenerated(true);
    } catch (err: any) {
      setError(err?.message || "Couldn't generate notes.");
    } finally {
      setLoading(false);
    }
  };

  // Auto-generate on mount.
  React.useEffect(() => {
    if (!generated && turns.length > 0) void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(notes);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked */ }
  };

  const save = () => {
    onSave({
      id: `s-${Date.now()}`,
      startedAt,
      endedAt: Date.now(),
      position: session.position,
      company: session.company,
      provider: apiConfig.provider,
      model: apiConfig.model,
      questionsAnswered: turns.length,
      notes,
      turns,
    });
    setSaved(true);
  };

  return (
    <div className="notes-wrap">
      <motion.div
        className="notes-panel glass-panel"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <header className="notes-head">
          <div>
            <h1 className="screen-title">Session notes</h1>
            <div className="notes-meta">
              <span>{fmtDuration(duration)}</span>
              <span>{turns.length} question{turns.length === 1 ? "" : "s"} answered</span>
              <span>{apiConfig.model}</span>
              {session.position && <span>{session.position}{session.company ? ` · ${session.company}` : ""}</span>}
            </div>
          </div>
          <div className="notes-actions">
            <button type="button" className="btn-ghost" onClick={copy} disabled={!notes}>
              {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy notes</>}
            </button>
            <button type="button" className="btn-ghost" onClick={save} disabled={saved || !generated}>
              {saved ? <><Check size={12} /> Saved</> : <><Save size={12} /> Save</>}
            </button>
            <button type="button" className="btn-primary" onClick={onNewSession}>
              <Plus size={13} /> New session
            </button>
          </div>
        </header>

        <div className="notes-body">
          {loading && (
            <div className="notes-loading">
              <Loader2 size={16} className="spin" />
              <Sparkles size={13} />
              <p>Writing your session notes…</p>
            </div>
          )}
          {error && (
            <div className="qa-error">
              <span>{error}</span>
              <button type="button" onClick={() => void generate()}>Retry</button>
            </div>
          )}
          {!loading && notes && <AnswerBody markdown={notes} />}
          {!loading && !notes && !error && turns.length === 0 && (
            <p className="settings-hint">No questions were answered in this session — nothing to summarise.</p>
          )}
        </div>

        <footer className="notes-history">
          <button type="button" className="extra-toggle" onClick={() => setShowHistory((v) => !v)}>
            <History size={11} /> Session history ({history.length})
          </button>
          {showHistory && (
            <div className="history-list">
              {history.length === 0 && <p className="settings-hint">Saved sessions will appear here.</p>}
              {history.map((r) => (
                <div key={r.id} className="history-item">
                  <div className="history-item-main">
                    <span className="history-title">{r.position || "Session"}{r.company ? ` · ${r.company}` : ""}</span>
                    <span className="history-sub">
                      {new Date(r.endedAt).toLocaleDateString()} · {r.questionsAnswered} Q&A · {r.model}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </footer>
      </motion.div>
    </div>
  );
}
