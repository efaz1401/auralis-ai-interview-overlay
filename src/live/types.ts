/** Shared types for the Live Answers engine. */

export type TurnStatus =
  | "queued"       // waiting in the stack
  | "thinking"     // request sent, no tokens yet
  | "streaming"    // tokens landing
  | "done"
  | "interrupted"  // parked because the interviewer asked something newer
  | "error";

/** Where a turn came from: detected speech, the manual-ask box, or Analyze Screen. */
export type TurnSource = "audio" | "manual" | "screen";

export interface Turn {
  id: string;
  question: string;
  /** Streamed markdown — may contain fenced code blocks. */
  answer: string;
  status: TurnStatus;
  /** Server's coding-question verdict, used for the badge and token budget. */
  isCoding: boolean;
  source: TurnSource;
  /** Analyze Screen turns keep their screenshot so park/resume and regenerate re-run the vision pipeline. */
  screenImage?: string;
  screenMime?: string;
  model?: string;
  error?: string;
  askedAt: number;
}

export type CaptureMode = "system" | "mic";

/** AUTO answers every detected question; MANUAL parks them as clickable chips. */
export type AnswerMode = "auto" | "manual";

/** A question crystallised from the transcript, shown as a chip in the rail. */
export interface DetectedQuestion {
  id: string;
  text: string;
  at: number;
  state: "detected" | "answering" | "answered";
}

export type Phase = "idle" | "starting" | "live";

export interface LiveContext {
  role?: string;
  company?: string;
  resumeText?: string;
  extraContext?: string;
  language?: string;
}
