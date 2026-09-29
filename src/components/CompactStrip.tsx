/**
 * CompactStrip — compact mode: one 96px strip below the top bar showing ONLY
 * the newest answer (question one-liner + 2-line clamp body + queue badge).
 * Click anywhere to restore full size.
 */

import React from "react";
import { Layers, Maximize2 } from "lucide-react";
import type { EngineState } from "../live/engine";
import { toPlainText } from "../live/markdown";

export default function CompactStrip({ state }: { state: EngineState | null }) {
  const api = window.electronOverlay;
  const latest = state?.turns?.[state.turns.length - 1];

  return (
    <button
      type="button"
      className="compact-strip glass-panel"
      onClick={() => api?.setCompact(false)}
      title="Expand window (Ctrl+Shift+C)"
    >
      {latest ? (
        <div className="compact-latest">
          <span className="compact-question">{latest.question}</span>
          <span className="compact-body">
            {latest.answer ? toPlainText(latest.answer) : latest.status === "error" ? (latest.error || "Failed") : "Working out the answer…"}
          </span>
        </div>
      ) : (
        <div className="compact-latest">
          <span className="compact-question">Auralis</span>
          <span className="compact-body">Listening for questions…</span>
        </div>
      )}
      <div className="compact-side">
        {state && state.pending > 0 && (
          <span className="compact-queue"><Layers size={10} /> {state.pending} waiting</span>
        )}
        <Maximize2 size={12} className="compact-expand" />
      </div>
    </button>
  );
}
