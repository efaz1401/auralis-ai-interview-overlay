/**
 * KeyGate — the access-key lock screen. Shown before anything else, and again
 * as a full veil when a key is revoked/expired mid-session.
 */

import React, { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Hexagon, LockKeyhole } from "lucide-react";
import { formatKeyInput, KEY_RE, lockMessage, validateKey, type GateResult } from "../auth/gate";

interface KeyGateProps {
  /** Initial key (from cache) — used for silent re-validation on launch. */
  initialKey?: string;
  /** When shown as a lock veil, the reason the app locked. */
  lockReason?: GateResult["reason"];
  onUnlock: (result: GateResult) => void;
}

export default function KeyGate({ initialKey = "", lockReason, onUnlock }: KeyGateProps) {
  const [value, setValue] = useState(initialKey);
  const [error, setError] = useState(lockReason ? lockMessage(lockReason) : "");
  const [checking, setChecking] = useState(false);
  const [shake, setShake] = useState(0);
  const attemptedSilent = useRef(false);

  const submit = async (key: string) => {
    if (checking) return;
    setChecking(true);
    setError("");
    const result = await validateKey(key);
    setChecking(false);
    if (result.valid) {
      onUnlock(result);
    } else {
      setError(lockMessage(result.reason));
      setShake((n) => n + 1);
    }
  };

  // Silent re-validation on launch when a cached key exists.
  useEffect(() => {
    if (attemptedSilent.current || !initialKey || !KEY_RE.test(initialKey)) return;
    attemptedSilent.current = true;
    void submit(initialKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit(value);
  };

  return (
    <div className="gate-backdrop">
      <motion.div
        key={shake}
        className={"gate-card glass-panel" + (error ? " gate-error" : "")}
        initial={{ opacity: 0, y: 8, x: 0 }}
        animate={{ opacity: 1, y: 0, x: shake ? [0, -4, 4, -3, 3, 0] : 0 }}
        transition={{ duration: shake ? 0.3 : 0.18, ease: "easeOut" }}
      >
        {checking && <div className="gate-progress" />}

        <div className="gate-mark">
          <Hexagon size={40} strokeWidth={1.2} className="gate-hex" />
          <LockKeyhole size={15} className="gate-lock" />
        </div>

        <h1 className="gate-title">Enter access key</h1>
        <p className="gate-sub">Auralis unlocks with a valid access key.</p>

        <form onSubmit={onSubmit}>
          <input
            className="gate-input"
            value={value}
            onChange={(e) => setValue(formatKeyInput(e.target.value))}
            placeholder="AUR-XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={19}
            autoFocus
            aria-label="Access key"
          />
          {error && <p className="gate-error-text" role="alert">{error}</p>}
          <button
            type="submit"
            className="gate-unlock"
            disabled={checking || !KEY_RE.test(value)}
          >
            {checking ? "Validating…" : "Unlock"}
          </button>
        </form>
      </motion.div>
    </div>
  );
}
