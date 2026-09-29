/**
 * Auralis server — live interview copilot backend.
 *
 * Providers: OpenAI, Groq and xAI Grok — all through the OpenAI SDK (Groq and
 * xAI expose OpenAI-compatible endpoints). Answers stream over SSE from the
 * first token; only non-reasoning models are used.
 *
 * Speech-to-text is Deepgram ONLY, read exclusively from DEEPGRAM_API_KEY in
 * the server .env. Answer-generation keys come from the app's Settings panel
 * (multi-key rotation on 429) and may additionally be provided via .env.
 */

import express from "express";
import path from "path";
import http from "http";
import https from "https";
import dotenv from "dotenv";
import OpenAI from "openai";
import { WebSocketServer, WebSocket as NodeWS } from "ws";

dotenv.config();

// Keep-alive TLS pooling reduces handshake overhead on repeated provider calls.
https.globalAgent = new https.Agent({ keepAlive: true });

const DEFAULT_PORT = Number(process.env.PORT) || 3000;

// ── Providers ───────────────────────────────────────────────────────────────

export type Provider = "openai" | "groq" | "grok";

interface ProviderDef {
  label: string;
  /** undefined = OpenAI default endpoint. */
  baseURL?: string;
  models: string[];
  defaultModel: string;
}

const PROVIDERS: Record<Provider, ProviderDef> = {
  openai: {
    label: "OpenAI",
    models: ["gpt-4o-mini", "gpt-4o"],
    defaultModel: "gpt-4o-mini",
  },
  groq: {
    label: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile"],
    defaultModel: "llama-3.3-70b-versatile",
  },
  grok: {
    label: "Grok",
    baseURL: "https://api.x.ai/v1",
    models: ["grok-4-fast-non-reasoning"],
    defaultModel: "grok-4-fast-non-reasoning",
  },
};

const VISION_MODEL_OPENAI = "gpt-4o";

// ── API keys ────────────────────────────────────────────────────────────────

/** Merge user-supplied keys (Settings) with server .env keys, de-duplicated. */
function mergeKeys(userStr?: string, envStr?: string): string[] {
  const u = (userStr || "").split(",").map((k) => k.trim()).filter(Boolean);
  const e = (envStr || "").split(",").map((k) => k.trim()).filter(Boolean);
  return Array.from(new Set([...u, ...e]));
}

function getKeys(provider: Provider, apiConfig?: any): string[] {
  switch (provider) {
    case "openai": return mergeKeys(apiConfig?.openaiKeys, process.env.OPENAI_API_KEY);
    case "groq":   return mergeKeys(apiConfig?.groqKeys, process.env.GROQ_API_KEY);
    case "grok":   return mergeKeys(apiConfig?.grokKeys, process.env.XAI_API_KEY);
  }
}

/** Deepgram is STT-only and server-side only — never accepted from the client. */
function getDeepgramKey(): string {
  return (process.env.DEEPGRAM_API_KEY || "").trim();
}

/**
 * Rotation cursors. The modulo is applied against the CURRENT key list on every
 * read, so a cursor can never go stale when the user edits their key list.
 */
const keyCursor: Record<Provider, number> = { openai: 0, groq: 0, grok: 0 };
function startIndex(provider: Provider, count: number): number {
  if (count <= 0) return 0;
  return keyCursor[provider] % count;
}
function rotate(provider: Provider, count: number): void {
  if (count > 0) keyCursor[provider] = (keyCursor[provider] + 1) % count;
}

// ── Request resolution ──────────────────────────────────────────────────────

interface ResolvedLLM {
  provider: Provider;
  model: string;
  keys: string[];
}

/** Resolve provider + model from the per-session picker, with key fallback. */
function resolveLLM(apiConfig?: any): ResolvedLLM {
  const requested: Provider =
    apiConfig?.provider === "groq" || apiConfig?.provider === "grok" ? apiConfig.provider : "openai";

  const pickModel = (p: Provider): string => {
    const m = String(apiConfig?.model || "");
    return PROVIDERS[p].models.includes(m) ? m : PROVIDERS[p].defaultModel;
  };

  if (getKeys(requested, apiConfig).length > 0) {
    return { provider: requested, model: pickModel(requested), keys: getKeys(requested, apiConfig) };
  }
  // Requested provider has no key — fall through to any provider that does.
  for (const p of ["openai", "groq", "grok"] as Provider[]) {
    const keys = getKeys(p, apiConfig);
    if (keys.length > 0) return { provider: p, model: pickModel(p), keys };
  }
  return { provider: requested, model: pickModel(requested), keys: [] };
}

function makeClient(provider: Provider, apiKey: string): OpenAI {
  const def = PROVIDERS[provider];
  return new OpenAI({ apiKey, ...(def.baseURL ? { baseURL: def.baseURL } : {}) });
}

/** Turn provider/SDK errors into something a user can act on. */
function friendlyProviderError(err: any, provider: Provider): string {
  const status = err?.status ?? err?.response?.status;
  const msg = String(err?.message || err || "");
  const name = PROVIDERS[provider].label;

  if (/No .*API key/i.test(msg)) return `No ${name} API key set. Open Settings and paste a key.`;
  if (status === 401 || status === 403 || /invalid.*api.?key|unauthor/i.test(msg)) {
    return `Your ${name} API key was rejected (${status || "auth error"}). Check it in Settings.`;
  }
  if (status === 429 || msg.includes("429")) {
    return `${name} is rate-limited right now. Wait a moment or add another key in Settings.`;
  }
  if (status === 404 || /not_found|does not exist/i.test(msg)) {
    return `The model isn't available on your ${name} account (404). Pick another model in Session Setup.`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) {
    return `Couldn't reach ${name} (network or provider outage). Retry, or switch provider.`;
  }
  return `${name} error: ${msg.slice(0, 200)}`;
}

/**
 * Non-streaming chat completion with multi-key rotation on 429.
 * Each attempt recomputes the index against the live key list (no stale index).
 */
async function chatOnce(
  apiConfig: any,
  systemPrompt: string | undefined,
  userPrompt: string,
  opts: { json?: boolean; maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const { provider, model, keys } = resolveLLM(apiConfig);
  if (keys.length === 0) throw new Error(`No ${PROVIDERS[provider].label} API key provided.`);

  const messages: any[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const maxTokens = opts.maxTokens ?? 4096;
  let lastErr: any;

  // Try every key once, starting at the rotation cursor.
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (startIndex(provider, keys.length) + attempt) % keys.length;
    try {
      const client = makeClient(provider, keys[idx]);
      const completion = await client.chat.completions.create({
        model,
        messages,
        temperature: opts.temperature ?? 0.6,
        max_tokens: maxTokens,
        ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
      });
      rotate(provider, keys.length); // next request starts on the following key
      return completion.choices[0]?.message?.content || "";
    } catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      if (status === 429) {
        rotate(provider, keys.length);
        console.warn(`[Auralis] ${provider} rate limited — rotating to next key (${keys.length} total).`);
        continue;
      }
      throw err; // non-429 errors are not key-specific
    }
  }
  throw lastErr;
}

/**
 * Streaming chat completion — yields text deltas from the FIRST token.
 * Rotates keys on 429 before the stream opens; once tokens flow, committed.
 */
async function* chatStream(
  apiConfig: any,
  messages: any[],
  opts: { maxTokens?: number; temperature?: number; force?: { provider: Provider; model: string } } = {},
): AsyncGenerator<string> {
  const resolved = resolveLLM(apiConfig);
  const provider = opts.force?.provider ?? resolved.provider;
  const model = opts.force?.model ?? resolved.model;
  const keys = getKeys(provider, apiConfig);
  if (keys.length === 0) throw new Error(`No ${PROVIDERS[provider].label} API key provided.`);

  let lastErr: any;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (startIndex(provider, keys.length) + attempt) % keys.length;
    try {
      const client = makeClient(provider, keys[idx]);
      const stream = await client.chat.completions.create({
        model,
        messages,
        temperature: opts.temperature ?? 0.6,
        max_tokens: opts.maxTokens ?? 3072,
        stream: true,
      });
      rotate(provider, keys.length);
      for await (const part of stream) {
        const piece = part.choices?.[0]?.delta?.content;
        if (piece) yield piece;
      }
      return;
    } catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      if (status === 429) {
        rotate(provider, keys.length);
        console.warn(`[Auralis] ${provider} stream rate limited — rotating key.`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Plain-text streaming wrapper for prompt-style calls. */
function streamPrompt(apiConfig: any, system: string | undefined, user: string, maxTokens = 3072): AsyncGenerator<string> {
  const messages: any[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  return chatStream(apiConfig, messages, { maxTokens });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Robust JSON extraction — recovers from stray prose or truncation. */
function parseJsonLoose(text: string): any {
  const clean = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(clean); } catch {}
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try { return JSON.parse(clean.slice(first, last + 1)); } catch {}
  }
  throw new Error("Unparseable AI JSON");
}

/** Clean transcript: strip markdown fences, extra whitespace, STT labels. */
function cleanTranscript(raw: any): string {
  if (!raw) return "";
  return String(raw)
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/\[.*?\]/g, "")
    .replace(/^(transcript|speech|audio):/i, "")
    .trim();
}

/** Server-side coding detector (mirrors the client heuristic). */
const CODING_QUESTION_RE = /(writ(e|ing)\s+(a\s+|the\s+)?(code|function|method|program|class|query|solution)|implement\s+(a|an|the)?|code\s+(this|it|a|the|up)|coding\s+(question|problem|challenge|exercise)|leetcode|hackerrank|codesignal|algorithm|time\s+complexity|space\s+complexity|big[\s-]?o|recursi|dynamic\s+programming|binary\s+search|linked\s+list|binary\s+tree|hash\s?map|subsequence|substring|palindrome|fibonacci|factorial|anagram|reverse\s+(a|the|this)|sort\s+(a|the|this|an)|sql\s+query|given\s+(a|an|the)\s+(string|array|list|integer|number|matrix|tree|linked\s+list)[^.?!]*\b(return|find|count|output|print|determine|compute|calculate)\b)/i;
const looksLikeCodingQuestion = (q: string) => CODING_QUESTION_RE.test(q || "");

/** Shared prompt for the live interview copilot. */
function buildLiveAnswerPrompt(o: {
  question: string; role?: string; company?: string; resumeText?: string;
  extraContext?: string; language?: string;
  history?: Array<{ question?: string; answer?: string }>;
}) {
  const system = `You are Auralis, a real-time interview copilot. The candidate is in a LIVE interview right now and reads your output while speaking. Be immediately useful:
- Lead with the answer. No preamble, no "great question", no restating the prompt.
- Write in ${o.language || "English"}.
- Prose answers: 3-6 tight sentences in first person, natural spoken ${o.language || "English"} the candidate can say verbatim.
- If the interviewer asks for CODE, an algorithm, a function, a query, or a "how would you implement" problem, you MUST output a complete, correct, runnable solution inside a fenced code block with a language tag (\`\`\`python). Then add one short line of time/space complexity and 1-2 sentences the candidate can say while presenting it. Never describe code without writing it.
- Prefer clarity over cleverness. Never truncate code.`;

  const priorTurns = Array.isArray(o.history) ? o.history.slice(-3) : [];
  const priorBlock = priorTurns.length
    ? `\nEarlier in this interview (most recent last):\n${priorTurns
        .map((t) => `Q: ${String(t?.question || "").slice(0, 300)}\nA: ${String(t?.answer || "").slice(0, 700)}`)
        .join("\n\n")}\n\nIf the new question is a follow-up, build on the above instead of repeating it.\n`
    : "";

  const user = `Candidate role: ${o.role || "Software Engineer"}${o.company ? ` at ${o.company}` : ""}${o.resumeText ? `\nBackground: ${String(o.resumeText).slice(0, 600)}` : ""}${o.extraContext ? `\nExtra context: ${String(o.extraContext).slice(0, 400)}` : ""}
${priorBlock}
The interviewer just asked:
"""${o.question}"""

Answer now.`;

  return { system, user };
}

/** Vision prompt for Analyze Screen — a structured, streamed solution. */
const SCREEN_ANALYSIS_SYSTEM = `You are Auralis, a real-time interview copilot. The candidate has shared a screenshot of their screen during a live interview — typically a coding problem, technical question, or document they must respond to RIGHT NOW.

Analyze the image and stream a structured solution in markdown with exactly these sections:
## Problem
One or two sentences restating what is on screen.
## Approach
A concise strategy in 2-4 bullets the candidate can say out loud.
## Solution
If it is a coding problem: a complete, correct, runnable solution in a fenced code block with a language tag. Otherwise: a strong spoken answer in 3-6 first-person sentences.
## Complexity
For code: "Time O(...), Space O(...)" plus one sentence of explanation. Omit this section for non-code problems.

Lead with content — no preamble, no "the image shows". Never truncate code.`;

// ── Supabase access-key validation ──────────────────────────────────────────

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function validateAccessKey(key: string, deviceId: string): Promise<any> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // Dev mode: no Supabase configured — accept any well-formed key so local
    // development isn't blocked. Never triggers in a properly deployed build.
    if (/^AUR-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/i.test(key)) {
      console.warn("[Auralis] Supabase not configured — dev-mode key acceptance. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.");
      return { valid: true, reason: "dev_mode", label: "Development", expires_at: null, devices: 1, max_devices: 99 };
    }
    return { valid: false, reason: "invalid" };
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/validate_key`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_key: key, p_device_id: deviceId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Auth service error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Express app ─────────────────────────────────────────────────────────────

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "30mb" }));

  // Health check — also reports which providers actually have a usable key so
  // the UI can warn before the user starts a live session.
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      providers: {
        openai: getKeys("openai").length > 0,
        groq: getKeys("groq").length > 0,
        grok: getKeys("grok").length > 0,
      },
      stt: getDeepgramKey() ? "deepgram" : "missing",
      auth: SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? "supabase" : "dev",
    });
  });

  // ── ACCESS KEY GATE ───────────────────────────────────────────────────────
  app.post("/api/auth/validate", async (req, res) => {
    try {
      const { key, deviceId } = req.body || {};
      if (!key || !deviceId) return res.status(400).json({ valid: false, reason: "invalid" });
      const result = await validateAccessKey(String(key), String(deviceId));
      res.json(result);
    } catch (err: any) {
      console.error("[Auralis] auth/validate error:", err?.message || err);
      res.status(502).json({ valid: false, reason: "service", error: "Auth service unavailable." });
    }
  });

  // ── LIVE ANSWER (STREAMING) ───────────────────────────────────────────────
  // SSE: {"delta":"..."} frames, then {"done":true}. The client renders deltas
  // as they land so the candidate reads the answer from the first token.
  app.post("/api/live-answer-stream", async (req, res) => {
    const { question, role, company, resumeText, extraContext, language, history, apiConfig } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ error: "No question provided" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    (res as any).flushHeaders?.();

    const send = (obj: any) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      (res as any).flush?.();
    };

    // Watch the RESPONSE, not the request: express.json() already drained req,
    // so req "close" fires immediately and is meaningless here.
    let clientGone = false;
    res.on("close", () => { clientGone = true; });

    const wantsCode = looksLikeCodingQuestion(String(question));
    const { system, user } = buildLiveAnswerPrompt({ question, role, company, resumeText, extraContext, language, history });
    const resolved = resolveLLM(apiConfig);

    send({ provider: resolved.provider, model: resolved.model, isCoding: wantsCode });

    // Heartbeats keep intermediaries from closing an idle connection.
    const heartbeat = setInterval(() => {
      if (!clientGone) { res.write(": ping\n\n"); (res as any).flush?.(); }
    }, 15000);

    let produced = 0;
    try {
      for await (const delta of streamPrompt(apiConfig, system, user, wantsCode ? 8192 : 3072)) {
        if (clientGone) break;
        produced += delta.length;
        send({ delta });
      }
      if (!clientGone) {
        if (produced === 0) send({ error: "The model returned an empty response. Try Regenerate." });
        send({ done: true });
      }
    } catch (err: any) {
      console.error("[Auralis] live-answer-stream error:", err?.message || err);
      if (!clientGone) {
        send({ error: friendlyProviderError(err, resolved.provider) });
        send({ done: true });
      }
    } finally {
      clearInterval(heartbeat);
      if (!clientGone) res.end();
    }
  });

  // ── ANALYZE SCREEN (VISION, STREAMING) ────────────────────────────────────
  // The Electron main process captures the screen; the renderer posts the PNG
  // plus session context and we stream a structured solution.
  app.post("/api/analyze-screen-stream", async (req, res) => {
    const { image, mimeType, role, company, resumeText, extraContext, language, history, question, apiConfig } = req.body || {};
    if (!image || !String(image).trim()) {
      return res.status(400).json({ error: "No image provided" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    (res as any).flushHeaders?.();

    const send = (obj: any) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      (res as any).flush?.();
    };
    let clientGone = false;
    res.on("close", () => { clientGone = true; });
    const heartbeat = setInterval(() => {
      if (!clientGone) { res.write(": ping\n\n"); (res as any).flush?.(); }
    }, 15000);

    const priorTurns = Array.isArray(history) ? history.slice(-2) : [];
    const contextText = [
      `Candidate role: ${role || "Software Engineer"}${company ? ` at ${company}` : ""}.`,
      resumeText ? `Background: ${String(resumeText).slice(0, 400)}` : "",
      extraContext ? `Extra context: ${String(extraContext).slice(0, 300)}` : "",
      language && language !== "English" ? `Write the answer in ${language}.` : "",
      question ? `The candidate's question about the screen: ${String(question).slice(0, 300)}` : "",
      priorTurns.length
        ? `Earlier in this interview:\n${priorTurns.map((t: any) => `Q: ${String(t?.question || "").slice(0, 200)}`).join("\n")}`
        : "",
    ].filter(Boolean).join("\n");

    const imageUrl = `data:${mimeType || "image/png"};base64,${image}`;
    const visionMessages = (text: string) => [{
      role: "user",
      content: [
        { type: "text", text },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    }];

    // Vision path: Grok when the session provider is grok and it has a key,
    // otherwise OpenAI gpt-4o. If Grok vision fails, fall back to OpenAI.
    const attempts: Array<{ provider: Provider; model: string }> = [];
    if (apiConfig?.provider === "grok" && getKeys("grok", apiConfig).length > 0) {
      attempts.push({ provider: "grok", model: PROVIDERS.grok.defaultModel });
    }
    attempts.push({ provider: "openai", model: VISION_MODEL_OPENAI });

    let produced = 0;
    try {
      let streamed = false;
      let lastErr: any;
      for (const attempt of attempts) {
        if (getKeys(attempt.provider, apiConfig).length === 0) continue;
        try {
          send({ provider: attempt.provider, model: attempt.model, isCoding: true, vision: true });
          for await (const delta of chatStream(apiConfig, [
            { role: "system", content: SCREEN_ANALYSIS_SYSTEM },
            ...visionMessages(contextText),
          ], { maxTokens: 8192, force: attempt })) {
            if (clientGone) break;
            produced += delta.length;
            send({ delta });
          }
          streamed = true;
          break;
        } catch (err: any) {
          lastErr = err;
          console.warn(`[Auralis] vision via ${attempt.provider} failed:`, err?.message || err);
          if (produced > 0) throw err; // tokens already flowed — don't retry mid-answer
        }
      }
      if (!streamed && produced === 0) throw lastErr || new Error("No vision provider available. Add an OpenAI key in Settings.");
      if (!clientGone) send({ done: true });
    } catch (err: any) {
      console.error("[Auralis] analyze-screen-stream error:", err?.message || err);
      if (!clientGone) {
        send({ error: friendlyProviderError(err, apiConfig?.provider === "grok" ? "grok" : "openai") });
        send({ done: true });
      }
    } finally {
      clearInterval(heartbeat);
      if (!clientGone) res.end();
    }
  });

  // ── SESSION NOTES ─────────────────────────────────────────────────────────
  // Generates the AI Notes sheet shown after End Session.
  app.post("/api/session-notes", async (req, res) => {
    try {
      const { turns, role, company, language, apiConfig } = req.body || {};
      const list = Array.isArray(turns) ? turns.filter((t: any) => t?.question && t?.answer) : [];
      if (!list.length) return res.status(400).json({ error: "No answered questions to summarise" });

      const transcript = list
        .slice(-20)
        .map((t: any, i: number) => `Q${i + 1}: ${String(t.question).slice(0, 400)}\nA${i + 1}: ${String(t.answer).slice(0, 1200)}`)
        .join("\n\n");

      const prompt = `You are Auralis. A live interview for the role of "${role || "Software Engineer"}"${company ? ` at "${company}"` : ""} just ended. Here are the questions the interviewer asked and the answers the candidate gave (assisted by you):

${transcript}

Write session notes in ${language || "English"} as markdown with exactly these sections:
## Summary
3-4 sentences on how the interview went and its main themes.
## Key Q&As
A bullet list of the 3-6 most important exchanges: **question** — one-line takeaway.
## Action items
A short bullet list of what the candidate should review or prepare before the next round.

Be specific; reference actual topics from the interview. No preamble.`;

      const notes = await chatOnce(apiConfig, undefined, prompt, { maxTokens: 2048 });
      res.json({ notes: notes || "" });
    } catch (err: any) {
      console.error("[Auralis] session-notes error:", err?.message || err);
      res.status(500).json({ error: friendlyProviderError(err, resolveLLM(req.body?.apiConfig).provider) });
    }
  });

  // ── TRANSCRIBE ONLY (Deepgram, chunked fallback path) ────────────────────
  app.post("/api/transcribe-only", async (req, res) => {
    try {
      const { audio, mimeType } = req.body || {};
      if (!audio) return res.status(400).json({ error: "No audio data provided" });

      const deepgramKey = getDeepgramKey();
      if (!deepgramKey) {
        return res.json({ transcript: "", warning: "DEEPGRAM_API_KEY is missing from the server .env — transcription is off." });
      }

      const buffer = Buffer.from(audio, "base64");
      const dgRes = await fetch(
        "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&filler_words=false",
        {
          method: "POST",
          headers: {
            Authorization: `Token ${deepgramKey}`,
            "Content-Type": mimeType || "audio/webm",
          },
          body: buffer,
        },
      );
      if (!dgRes.ok) {
        const errText = await dgRes.text().catch(() => "");
        console.warn(`[Auralis] Deepgram STT HTTP ${dgRes.status}: ${errText.slice(0, 120)}`);
        return res.json({ transcript: "", warning: `Deepgram STT failed (${dgRes.status}). Check DEEPGRAM_API_KEY.` });
      }
      const dgData: any = await dgRes.json();
      const transcript = cleanTranscript(dgData?.results?.channels?.[0]?.alternatives?.[0]?.transcript);
      res.json({ transcript });
    } catch (error: any) {
      console.error("[Auralis] transcribe-only error:", error?.message || error);
      res.json({ transcript: "", warning: "Speech-to-text error — capture continues." });
    }
  });

  // ── SEGMENT QUESTIONS ─────────────────────────────────────────────────────
  // Splits a rolling transcript into complete questions plus a remainder.
  app.post("/api/segment-questions", async (req, res) => {
    try {
      const { buffer, role, apiConfig } = req.body || {};
      if (!buffer || !String(buffer).trim()) return res.json({ questions: [], remainder: "" });

      const prompt = `You are parsing a live, rolling transcript of an interviewer speaking during a job interview for a "${role || "Software Engineer"}" role. The transcript may contain filler, partial sentences, and one or more questions.

Transcript so far:
"""${buffer}"""

Your job:
1. Extract each COMPLETE question or explicit prompt the interviewer has fully FINISHED asking, as clean standalone text. Fix obvious transcription glitches but do not invent content.
2. If the transcript ends in the MIDDLE of a sentence/question that is not finished yet, put that trailing unfinished text in "remainder" so it can be completed later. If everything is complete, remainder must be an empty string.
3. Ignore pure filler or acknowledgements ("okay", "great", "mm-hmm", "so", "yeah") — never turn them into questions.
4. Preserve the interviewer's original order.

Return ONLY valid JSON:
{
  "questions": ["full question 1", "full question 2"],
  "remainder": "trailing unfinished text, or empty string"
}`;

      const responseText = await chatOnce(apiConfig, undefined, prompt, { json: true, maxTokens: 1024, temperature: 0 });
      const result = parseJsonLoose(responseText);
      res.json({
        questions: Array.isArray(result.questions) ? result.questions.filter((q: string) => q && q.trim()) : [],
        remainder: typeof result.remainder === "string" ? result.remainder : "",
      });
    } catch (error: any) {
      console.error("[Auralis] segment-questions error:", error?.message || error);
      // Fallback: naive '?'-based splitting so the pipeline still advances.
      const raw = String(req.body?.buffer || "");
      if (raw.includes("?")) {
        const parts = raw.split("?").map((s: string) => s.trim()).filter(Boolean);
        const endsClean = /\?\s*$/.test(raw);
        const questions = parts
          .map((p: string, i: number) => (i < parts.length - 1 || endsClean) ? `${p}?` : null)
          .filter((q: string | null): q is string => q !== null);
        const remainder = endsClean ? "" : (parts[parts.length - 1] || "");
        res.json({ questions, remainder });
      } else {
        res.json({ questions: [], remainder: raw });
      }
    }
  });

  return app;
}

export interface StartServerOptions {
  port?: number;
  mode?: "development" | "production";
  distPath?: string;
}

// ── Deepgram real-time WebSocket proxy (/ws/deepgram) ───────────────────────
//
// The renderer sends an optional `{"type":"auth"}` frame (kept for protocol
// compatibility — the key is ALWAYS read from the server's DEEPGRAM_API_KEY)
// then raw 16-bit PCM @ 16 kHz mono frames. Transcript JSON is relayed back
// verbatim.
export function attachDeepgramProxy(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/ws/deepgram") {
        wss.handleUpgrade(request, socket as any, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (clientWs) => {
    let dgWs: NodeWS | null = null;
    let authenticated = false;

    const openUpstream = () => {
      const deepgramKey = getDeepgramKey();
      if (!deepgramKey) {
        clientWs.send(JSON.stringify({ type: "error", message: "DEEPGRAM_API_KEY missing on the server." }));
        return;
      }
      const dgUrl =
        "wss://api.deepgram.com/v1/listen" +
        "?model=nova-3" +
        "&encoding=linear16" +
        "&sample_rate=16000" +
        "&channels=1" +
        "&interim_results=true" +
        "&smart_format=true" +
        "&punctuate=true" +
        "&filler_words=false" +
        "&endpointing=500";

      dgWs = new NodeWS(dgUrl, { headers: { Authorization: `Token ${deepgramKey}` } });

      dgWs.on("open", () => {
        clientWs.send(JSON.stringify({ type: "ready" }));
        console.log("[Auralis] Deepgram streaming WS opened.");
      });
      dgWs.on("message", (dgData) => {
        if (clientWs.readyState === clientWs.OPEN) clientWs.send(dgData.toString());
      });
      dgWs.on("error", (err) => {
        console.error("[Auralis] Deepgram WS error:", err.message);
        if (clientWs.readyState === clientWs.OPEN) {
          clientWs.send(JSON.stringify({ type: "error", message: `Deepgram: ${err.message}` }));
        }
      });
      dgWs.on("close", (code, reason) => {
        console.log(`[Auralis] Deepgram WS closed (${code}): ${reason.toString()}`);
        if (clientWs.readyState === clientWs.OPEN) clientWs.close();
      });
    };

    clientWs.on("message", (data, isBinary) => {
      // ── Auth frame (JSON, must arrive first — key comes from server .env) ─
      if (!authenticated) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type !== "auth") {
            clientWs.send(JSON.stringify({ type: "error", message: "First message must be {type:'auth'}" }));
            return;
          }
          authenticated = true;
          openUpstream();
        } catch (err: any) {
          clientWs.send(JSON.stringify({ type: "error", message: `Auth parse error: ${err?.message}` }));
        }
        return;
      }

      // ── Binary PCM audio frames: forward directly to Deepgram ────────────
      if (isBinary && dgWs && dgWs.readyState === NodeWS.OPEN) {
        dgWs.send(data);
      }
    });

    clientWs.on("close", () => {
      if (dgWs && dgWs.readyState === NodeWS.OPEN) {
        try { dgWs.send(JSON.stringify({ type: "CloseStream" })); } catch { /* ignore */ }
        dgWs.close();
      }
    });
    clientWs.on("error", () => { dgWs?.close(); });
  });
}

/**
 * Start the HTTP server. In development it attaches Vite in middleware mode;
 * in production it serves the built assets. Electron calls this directly.
 */
export async function startServer(options: StartServerOptions = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const mode =
    options.mode ?? (process.env.NODE_ENV === "production" ? "production" : "development");
  const app = createApp();

  if (mode !== "production") {
    // Lazy-load Vite so it is never bundled/needed in the packaged app.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = options.distPath ?? path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // Unknown /api/* paths must 404 as JSON — otherwise the SPA fallback
    // returns index.html and a typo'd route looks like a broken API response.
    app.all("/api/*", (req, res) => {
      res.status(404).json({ error: `Unknown API route: ${req.path}` });
    });
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const httpServer = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(port, "0.0.0.0", () => {
      console.log(`[Auralis Server] running on http://localhost:${port} (${mode})`);
      resolve(s);
    });
    s.on("error", reject);
  });

  attachDeepgramProxy(httpServer);

  return app;
}

// Auto-start when run directly (npm run dev / npm start).
// Electron sets ELECTRON_RUN and calls startServer() itself in production.
if (!process.env.ELECTRON_RUN) {
  startServer();
}
