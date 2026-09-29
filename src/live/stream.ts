/**
 * SSE clients for the streaming routes (/api/live-answer-stream and
 * /api/analyze-screen-stream).
 *
 * Both routes emit newline-delimited `data: {...}` frames plus `: ping`
 * heartbeat comments. Frames carry `{delta}`, `{error}`, `{done}` or an
 * opening metadata frame (`{provider, model, isCoding}`).
 */

import type { LiveContext } from "./types";

export interface StreamMeta {
  provider?: string;
  model?: string;
  isCoding?: boolean;
  vision?: boolean;
}

export interface StreamHandlers {
  onMeta?: (meta: StreamMeta) => void;
  onDelta: (delta: string) => void;
  onError?: (message: string) => void;
  /** Fires on every network read — lets the caller run an idle watchdog. */
  onActivity?: () => void;
}

export interface AnswerRequest extends LiveContext {
  question: string;
  history?: { question: string; answer: string }[];
  apiConfig: unknown;
}

export interface ScreenRequest extends LiveContext {
  /** base64-encoded PNG/JPEG of the screen (no data: prefix). */
  image: string;
  mimeType?: string;
  /** Optional typed question about what's on screen. */
  question?: string;
  history?: { question: string; answer: string }[];
  apiConfig: unknown;
}

async function readSse(res: Response, handlers: StreamHandlers): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      handlers.onActivity?.();
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // skips ": ping" heartbeats

        const payload = line.slice(5).trim();
        if (!payload) continue;

        let evt: any;
        try { evt = JSON.parse(payload); } catch { continue; }

        if (typeof evt.delta === "string" && evt.delta) handlers.onDelta(evt.delta);
        if (evt.error) handlers.onError?.(String(evt.error));
        if (evt.model || evt.provider || typeof evt.isCoding === "boolean" || evt.vision) {
          handlers.onMeta?.({ provider: evt.provider, model: evt.model, isCoding: evt.isCoding, vision: evt.vision });
        }
        if (evt.done) return;
      }
    }
  } finally {
    // Abandoning a half-read stream would otherwise hold the connection open.
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

async function postSse(url: string, body: unknown, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = `The service returned ${res.status}.`;
    try {
      const data = await res.json();
      if (data?.error) message = String(data.error);
    } catch { /* body wasn't JSON */ }
    throw new Error(message);
  }

  await readSse(res, handlers);
}

export function streamAnswer(body: AnswerRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
  return postSse("/api/live-answer-stream", body, handlers, signal);
}

export function streamScreenAnalysis(body: ScreenRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
  return postSse("/api/analyze-screen-stream", body, handlers, signal);
}
