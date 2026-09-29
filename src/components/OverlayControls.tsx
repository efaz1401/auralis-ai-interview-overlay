/**
 * OverlayControls — the draggable 36px Glacier top bar.
 *
 * Grip + wordmark + live status dot, two inline mini-sliders (glass alpha and
 * text alpha), then ghost icon buttons: click-through, stealth
 * (content-protection), compact, minimize, close. All IPC behavior unchanged.
 * Renders nothing in a normal browser.
 */

import React, { useEffect, useState } from "react";
import {
  X,
  Minus,
  MousePointerClick,
  MousePointer2,
  ShieldCheck,
  ShieldOff,
  GripHorizontal,
  Minimize2,
  Maximize2,
  CaseSensitive,
  PanelsTopLeft,
} from "lucide-react";

interface OverlayControlsProps {
  liveActive?: boolean;
  glassAlpha: number;
  textAlpha: number;
  onAlphaChange: (kind: "glass" | "text", value: number) => void;
}

export default function OverlayControls({ liveActive = false, glassAlpha, textAlpha, onAlphaChange }: OverlayControlsProps) {
  const api = typeof window !== "undefined" ? window.electronOverlay : undefined;
  const [clickThrough, setClickThroughState] = useState(false);
  const [stealth, setStealth] = useState(true);
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    if (!api) return;
    api.getState().then((s) => {
      if (typeof s.clickThrough === "boolean") setClickThroughState(s.clickThrough);
      if (typeof s.contentProtected === "boolean") setStealth(s.contentProtected);
      if (typeof s.isCompact === "boolean") setIsCompact(s.isCompact);
    });
    const off = api.onState((s) => {
      if (typeof s.clickThrough === "boolean") setClickThroughState(s.clickThrough);
      if (typeof s.contentProtected === "boolean") setStealth(s.contentProtected);
      if (typeof s.isCompact === "boolean") setIsCompact(s.isCompact);
    });
    return off;
  }, [api]);

  if (!api) return null;

  const toggleClick = () => {
    const v = !clickThrough;
    api.setClickThrough(v);
    setClickThroughState(v);
  };

  const toggleStealth = () => {
    const v = !stealth;
    api.setContentProtection(v);
    setStealth(v);
  };

  const toggleCompact = () => {
    const v = !isCompact;
    api.setCompact(v);
    setIsCompact(v);
  };

  return (
    <div className="overlay-bar">
      <div className="overlay-drag">
        <GripHorizontal size={13} className="ov-grip" />
        <span className="overlay-title">Auralis</span>
        <span
          className={"ov-live-dot" + (liveActive ? " live" : "")}
          title={liveActive ? "Session live" : "Idle"}
        />
      </div>

      <div className="ov-sliders no-drag">
        <label className="ov-slider" title={`Panel opacity ${Math.round(glassAlpha * 100)}% (Ctrl+Shift+↑/↓)`}>
          <PanelsTopLeft size={11} />
          <input
            type="range"
            min={0.15}
            max={1}
            step={0.05}
            value={glassAlpha}
            onChange={(e) => onAlphaChange("glass", Number(e.target.value))}
            aria-label="Panel opacity"
          />
        </label>
        <label className="ov-slider" title={`Text opacity ${Math.round(textAlpha * 100)}% (Ctrl+Alt+↑/↓)`}>
          <CaseSensitive size={11} />
          <input
            type="range"
            min={0.3}
            max={1}
            step={0.05}
            value={textAlpha}
            onChange={(e) => onAlphaChange("text", Number(e.target.value))}
            aria-label="Text opacity"
          />
        </label>
      </div>

      <div className="overlay-actions no-drag">
        {/* Click-through toggle */}
        <button
          className={"ov-btn" + (clickThrough ? " ov-on" : "")}
          title={clickThrough ? "Click-through ON — clicks pass to app below" : "Click-through OFF (Ctrl+Shift+Space)"}
          onClick={toggleClick}
        >
          {clickThrough ? <MousePointer2 size={12} /> : <MousePointerClick size={12} />}
        </button>

        {/* Stealth toggle — hides from screen share */}
        <button
          className={"ov-btn" + (stealth ? " ov-on" : "")}
          title={stealth ? "Stealth ON — hidden from screen share" : "Stealth OFF — visible in screen share"}
          onClick={toggleStealth}
        >
          {stealth ? <ShieldCheck size={12} /> : <ShieldOff size={12} />}
        </button>

        {/* Compact mode toggle */}
        <button
          className={"ov-btn" + (isCompact ? " ov-on" : "")}
          title={isCompact ? "Expand window (Ctrl+Shift+C)" : "Collapse to strip (Ctrl+Shift+C)"}
          onClick={toggleCompact}
        >
          {isCompact ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
        </button>

        {/* Minimize to taskbar */}
        <button className="ov-btn" title="Minimize" onClick={() => api.minimize()}>
          <Minus size={12} />
        </button>

        {/* Quit */}
        <button className="ov-btn ov-close" title="Quit Auralis" onClick={() => api.quit()}>
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
