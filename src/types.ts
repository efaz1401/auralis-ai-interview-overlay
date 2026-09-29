/**
 * Shared client-side types for the Auralis live interview copilot.
 * Practice-mode types were removed — this app is live-only.
 */

export type AiProvider = "openai" | "groq" | "grok";

export interface ApiConfig {
  provider: AiProvider;
  /** Per-session model id — must be one of PROVIDER_MODELS[provider]. */
  model: string;
  openaiKeys: string;
  groqKeys: string;
  grokKeys: string;
}

/** Models offered in the per-session picker. All non-reasoning, first-token fast. */
export const PROVIDER_MODELS: Record<AiProvider, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o"],
  groq: ["llama-3.3-70b-versatile"],
  grok: ["grok-4-fast-non-reasoning"],
};

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  groq: "Groq",
  grok: "Grok",
};

export const DEFAULT_MODEL: Record<AiProvider, string> = {
  openai: "gpt-4o-mini",
  groq: "llama-3.3-70b-versatile",
  grok: "grok-4-fast-non-reasoning",
};

export const DEFAULT_API_CONFIG: ApiConfig = {
  provider: "openai",
  model: DEFAULT_MODEL.openai,
  openaiKeys: "",
  groqKeys: "",
  grokKeys: "",
};

/** Answer languages offered in Session Setup. */
export const ANSWER_LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Hindi",
  "Mandarin",
  "Japanese",
  "Korean",
];

/** Everything the live session needs, collected on the Session Setup screen. */
export interface SessionConfig {
  position: string;
  company: string;
  resumeText: string;
  extraContext: string;
  /** Language the answers are written in. */
  language: string;
  audioSource: "system" | "mic";
}

export const DEFAULT_SESSION: SessionConfig = {
  position: "",
  company: "",
  resumeText: "",
  extraContext: "",
  language: "English",
  audioSource: "system",
};

/** A finished session, kept in local history. */
export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  position: string;
  company: string;
  provider: AiProvider;
  model: string;
  questionsAnswered: number;
  /** Rendered AI notes (markdown). */
  notes: string;
  turns: { question: string; answer: string }[];
}

export type FontScale = "S" | "M" | "L";
