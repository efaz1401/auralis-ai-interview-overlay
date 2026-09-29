#!/usr/bin/env node
/**
 * Auralis access-key admin CLI.
 *
 * Uses the Supabase SERVICE ROLE key — keep it in a local .env (or export the
 * env vars) and NEVER ship this script inside the packaged app.
 *
 * Usage:
 *   node admin/keys.mjs generate [--label "Jane"] [--days 90] [--devices 2] [--count 3]
 *   node admin/keys.mjs list
 *   node admin/keys.mjs revoke  AUR-XXXX-XXXX-XXXX
 *   node admin/keys.mjs extend  AUR-XXXX-XXXX-XXXX --days 30
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env next to the repo root without adding a dependency.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const name of [".env", ".env.local"]) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (set them in .env or the environment).");
  process.exit(1);
}

const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

const hashKey = (key) =>
  crypto.createHash("sha256").update(key.replace(/\s+/g, "").toUpperCase()).digest("hex");

function makeKey() {
  const seg = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `AUR-${seg()}-${seg()}-${seg()}`;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

async function api(pathname, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const [, , command, target] = process.argv;

async function generate() {
  const count = Math.max(1, Number(arg("count", 1)));
  const label = String(arg("label", ""));
  const days = Number(arg("days", 0));
  const devices = Math.max(1, Number(arg("devices", 1)));
  const expires = days > 0 ? new Date(Date.now() + days * 864e5).toISOString() : null;

  const rows = [];
  const plaintexts = [];
  for (let i = 0; i < count; i++) {
    const key = makeKey();
    plaintexts.push(key);
    rows.push({ key_hash: hashKey(key), label, expires_at: expires, max_devices: devices });
  }
  await api("access_keys", { method: "POST", body: JSON.stringify(rows) });

  console.log(`\nGenerated ${count} key(s) — shown ONCE, store them safely:\n`);
  for (const k of plaintexts) console.log(`  ${k}`);
  if (expires) console.log(`\nExpires: ${expires}`);
  console.log(`Devices per key: ${devices}${label ? `  •  Label: ${label}` : ""}\n`);
}

async function list() {
  const rows = await api("access_keys?select=label,status,expires_at,max_devices,devices,created_at,last_seen_at&order=created_at.desc");
  if (!rows.length) return console.log("No keys yet.");
  console.log("");
  for (const r of rows) {
    const devices = Array.isArray(r.devices) ? r.devices.length : 0;
    console.log(
      `  ${String(r.status).padEnd(8)} ${String(r.label || "(no label)").padEnd(20)} ` +
      `devices ${devices}/${r.max_devices}  expires ${r.expires_at ? r.expires_at.slice(0, 10) : "never"}  ` +
      `last seen ${r.last_seen_at ? r.last_seen_at.slice(0, 10) : "—"}`
    );
  }
  console.log("");
}

async function patch(key, body, verb) {
  const rows = await api(`access_keys?key_hash=eq.${hashKey(key)}&select=id`, {});
  if (!rows.length) {
    console.error(`No key matches ${key}.`);
    process.exit(1);
  }
  await api(`access_keys?key_hash=eq.${hashKey(key)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  console.log(`${verb}: ${key}`);
}

async function revoke(key) {
  await patch(key, { status: "revoked" }, "Revoked");
}

async function extend(key) {
  const days = Number(arg("days", 30));
  if (!(days > 0)) {
    console.error("extend requires --days N");
    process.exit(1);
  }
  const rows = await api(`access_keys?key_hash=eq.${hashKey(key)}&select=expires_at`, {});
  if (!rows.length) {
    console.error(`No key matches ${key}.`);
    process.exit(1);
  }
  const base = rows[0].expires_at && new Date(rows[0].expires_at) > new Date()
    ? new Date(rows[0].expires_at)
    : new Date();
  const next = new Date(base.getTime() + days * 864e5).toISOString();
  await patch(key, { expires_at: next }, `Extended ${days}d (now expires ${next.slice(0, 10)})`);
}

const needsKey = ["revoke", "extend"].includes(command);
if (needsKey && !/^AUR-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/i.test(target || "")) {
  console.error(`Usage: node admin/keys.mjs ${command} AUR-XXXX-XXXX-XXXX${command === "extend" ? " --days N" : ""}`);
  process.exit(1);
}

try {
  if (command === "generate") await generate();
  else if (command === "list") await list();
  else if (command === "revoke") await revoke(target);
  else if (command === "extend") await extend(target);
  else {
    console.log("Commands: generate | list | revoke <key> | extend <key> --days N");
    process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
