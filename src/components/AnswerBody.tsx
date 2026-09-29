/**
 * Renders one streamed answer: prose, bullets and fenced code blocks.
 * A still-open fence renders as live code with a "writing…" marker instead of
 * being hidden, so the candidate can read the solution as it is typed.
 */

import React, { useState } from "react";
import { Check, Code2, Copy, Loader2 } from "lucide-react";
import { inlineParts, proseLines, splitAnswer, type Inline } from "../live/markdown";

function InlineText({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part: Inline, i: number) => {
        if (part.code) return <code key={i} className="md-inline-code">{part.text}</code>;
        if (part.bold) return <strong key={i}>{part.text}</strong>;
        if (part.italic) return <em key={i}>{part.text}</em>;
        return <React.Fragment key={i}>{part.text}</React.Fragment>;
      })}
    </>
  );
}

function CodeBlock({ lang, content, open }: { lang: string; content: string; open: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — nothing useful to show */ }
  };

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang"><Code2 size={9} /> {lang || "code"}</span>
        {open ? (
          <span className="code-writing"><Loader2 size={9} className="spin" /> writing…</span>
        ) : (
          <button className="code-copy" onClick={copy} type="button">
            {copied ? <><Check size={9} /> Copied</> : <><Copy size={9} /> Copy</>}
          </button>
        )}
      </div>
      <pre className="code-pre"><code>{content}</code></pre>
    </div>
  );
}

export default function AnswerBody({ markdown }: { markdown: string }) {
  const segments = splitAnswer(markdown);

  return (
    <div className="md-body">
      {segments.map((seg, i) => {
        if (seg.type === "code") {
          return (
            <React.Fragment key={i}>
              <CodeBlock lang={seg.lang} content={seg.content} open={seg.open} />
            </React.Fragment>
          );
        }
        return (
          <React.Fragment key={i}>
            {proseLines(seg.content).map((line, j) =>
              line.kind === "bullet" ? (
                <div key={j} className="md-bullet">
                  <span className="md-bullet-dot" />
                  <span><InlineText text={line.content} /></span>
                </div>
              ) : (
                <p key={j} className="md-para"><InlineText text={line.content} /></p>
              ),
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
