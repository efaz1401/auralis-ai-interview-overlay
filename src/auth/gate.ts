/**
 * Access-key gate — client side.
 *
 * The app is locked behind a Supabase-backed access key (no login system).
 * Validation happens against /api/auth/validate on the local server, which
 * calls the validate_key RPC. Results are cached for a 12h OFFLINE GRACE
 * period; the key is re-validated every 30 minutes while the app runs, and a
 * revoked/expired verdict locks the app immediately.
 */

export interface GateResult {
  valid: boolean;
  reason: "ok" | "invalid" | "revoked" | "expired" | "device_limit" | "service" | "offline" | "dev_mode";
  label?: string;
  expiresAt?: string | null;
  devices?: number;
  maxDevices?: number;
  /** True when the verdict came from the offline grace cache. */
  offline?: boolean;
}

interface GateCache {
  key: string;
  label?: string;
  expiresAt?: string | null;
  devices?: number;
  maxDevices?: number;
  /** Offline grace: last successful validation + 12h. */
  graceUntil: number;
}

const DEVICE_KEY = "auralis_device_id";
const CACHE_KEY = "auralis_gate_cache";
const GRACE_MS = 12 * 60 * 60 * 1000; // 12h offline grace

export const KEY_RE = /^AUR-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

/** Stable per-install device id for device binding. */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // localStorage unavailable (shouldn't happen in Electron) — ephemeral id.
    return `ephemeral-${Math.random().toString(36).slice(2)}`;
  }
}

export function cachedKey(): string {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? String(JSON.parse(raw).key || "") : "";
  } catch {
    return "";
  }
}

function readCache(): GateCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as GateCache) : null;
  } catch {
    return null;
  }
}

function writeCache(cache: GateCache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* ignore */ }
}

export function clearGate() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}

/** Status snapshot for the Settings panel. */
export function gateStatus(): { key: string; label?: string; expiresAt?: string | null; devices?: number; maxDevices?: number; graceUntil?: number } | null {
  const c = readCache();
  if (!c) return null;
  return { key: c.key, label: c.label, expiresAt: c.expiresAt, devices: c.devices, maxDevices: c.maxDevices, graceUntil: c.graceUntil };
}

/**
 * Validate a key against the server. On network failure, falls back to the
 * cached verdict while the 12h grace window is still open.
 */
export async function validateKey(key: string): Promise<GateResult> {
  const normalized = key.trim().toUpperCase();
  if (!KEY_RE.test(normalized)) {
    return { valid: false, reason: "invalid" };
  }

  try {
    const res = await fetch("/api/auth/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: normalized, deviceId: deviceId() }),
    });

    if (!res.ok) throw new Error(`validate ${res.status}`);
    const data = await res.json();

    if (data?.valid) {
      writeCache({
        key: normalized,
        label: data.label,
        expiresAt: data.expires_at ?? null,
        devices: data.devices,
        maxDevices: data.max_devices,
        graceUntil: Date.now() + GRACE_MS,
      });
      return {
        valid: true,
        reason: data.reason === "dev_mode" ? "dev_mode" : "ok",
        label: data.label,
        expiresAt: data.expires_at ?? null,
        devices: data.devices,
        maxDevices: data.max_devices,
      };
    }

    // Server reached and says no — revoked/expired/limited keys lock now.
    const reason = (["revoked", "expired", "device_limit"].includes(data?.reason) ? data.reason : "invalid") as GateResult["reason"];
    return { valid: false, reason, label: data?.label, expiresAt: data?.expires_at ?? null };
  } catch {
    // Network/server failure — offline grace if this exact key validated recently.
    const cache = readCache();
    if (cache && cache.key === normalized && cache.graceUntil > Date.now()) {
      return {
        valid: true,
        reason: "offline",
        offline: true,
        label: cache.label,
        expiresAt: cache.expiresAt,
        devices: cache.devices,
        maxDevices: cache.maxDevices,
      };
    }
    return { valid: false, reason: "service" };
  }
}

/** Re-validate the cached key (30-minute heartbeat while the app runs). */
export async function revalidate(): Promise<GateResult> {
  const key = cachedKey();
  if (!key) return { valid: false, reason: "invalid" };
  return validateKey(key);
}

/** Human-readable lock messages for the KeyGate error state. */
export function lockMessage(reason: GateResult["reason"]): string {
  switch (reason) {
    case "revoked": return "Key revoked";
    case "expired": return "Key expired";
    case "device_limit": return "Device limit reached";
    case "service": return "Couldn't reach the licensing server — check your connection";
    case "invalid": return "Invalid access key";
    default: return "Access locked";
  }
}

/** Auto-format input as AUR-XXXX-XXXX-XXXX while typing. */
export function formatKeyInput(raw: string): string {
  let s = raw.toUpperCase();
  if (s.startsWith("AUR-")) s = s.slice(4);
  else if (s.startsWith("AUR")) s = s.slice(3);
  const chars = s.replace(/[^0-9A-F]/g, "").slice(0, 12);
  if (!chars) return "";
  const groups = chars.match(/.{1,4}/g) || [];
  return `AUR-${groups.join("-")}`;
}
