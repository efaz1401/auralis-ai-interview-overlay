/**
 * Minimal markdown segmentation tuned for streaming.
 *
 * The answer arrives token by token, so a fenced block is routinely incomplete.
 * `splitAnswer` marks that block `open` instead of hiding it, letting the UI
 * render code as it is typed and suppress the copy button until it closes.
 */

export type Segment =
  | { type: "text"; content: string }
  | { type: "code"; lang: string; content: string; open: boolean };

const FENCE_RE = /^```([a-zA-Z0-9+#._-]*)\s*$/;

export function splitAnswer(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const lines = (markdown || "").split("\n");

  let inCode = false;
  let lang = "";
  let buf: string[] = [];

  const flushText = () => {
    const content = buf.join("\n");
    if (content.trim()) segments.push({ type: "text", content });
    buf = [];
  };

  for (const line of lines) {
    const fence = FENCE_RE.exec(line.trim());
    if (fence) {
      if (!inCode) {
        flushText();
        inCode = true;
        lang = fence[1] || "";
      } else {
        segments.push({ type: "code", lang, content: buf.join("\n"), open: false });
        buf = [];
        inCode = false;
        lang = "";
      }
      continue;
    }
    buf.push(line);
  }

  if (inCode) segments.push({ type: "code", lang, content: buf.join("\n"), open: true });
  else flushText();

  return segments;
}

/** First complete code block in an answer, if any — used by the copy action. */
export function firstCodeBlock(markdown: string): string {
  for (const seg of splitAnswer(markdown)) {
    if (seg.type === "code" && seg.content.trim()) return seg.content;
  }
  return "";
}

export interface TextLine {
  kind: "bullet" | "para";
  content: string;
}

/** Split prose into paragraphs and bullets so lists don't render as one blob. */
export function proseLines(text: string): TextLine[] {
  const out: TextLine[] = [];
  let para: string[] = [];

  const flush = () => {
    const joined = para.join(" ").trim();
    if (joined) out.push({ kind: "para", content: joined });
    para = [];
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      out.push({ kind: "bullet", content: bullet[1] });
    } else {
      para.push(line);
    }
  }
  flush();
  return out;
}

/** Render `**bold**`, `*italic*` and `` `code` `` as plain segments for React. */
export type Inline = { bold?: boolean; italic?: boolean; code?: boolean; text: string };

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;

export function inlineParts(text: string): Inline[] {
  const parts: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) parts.push({ text: text.slice(last, idx) });
    const token = match[0];
    if (token.startsWith("**")) parts.push({ bold: true, text: token.slice(2, -2) });
    else if (token.startsWith("`")) parts.push({ code: true, text: token.slice(1, -1) });
    else parts.push({ italic: true, text: token.slice(1, -1) });
    last = idx + token.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.length ? parts : [{ text }];
}

/** Strip markdown noise for clipboard-friendly plain text. */
export function toPlainText(markdown: string): string {
  return splitAnswer(markdown)
    .map((seg) => (seg.type === "code" ? seg.content : seg.content.replace(/\*\*|`/g, "")))
    .join("\n\n")
    .trim();
}
