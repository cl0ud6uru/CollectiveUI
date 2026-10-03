"use client";

import { memo, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Check, Copy } from "lucide-react";

const highlightCache = new Map<string, string>();

function useHighlighted(code: string, lang: string, enabled: boolean) {
  const key = `${lang}\u0000${code}`;
  const [result, setResult] = useState<{ key: string; html: string } | null>(null);
  useEffect(() => {
    if (!enabled || highlightCache.has(key)) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { codeToHtml, bundledLanguages } = await import("shiki");
        const language = lang in bundledLanguages ? lang : "text";
        const out = await codeToHtml(code, {
          lang: language,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: "light",
        });
        highlightCache.set(key, out);
        if (!cancelled) setResult({ key, html: out });
      } catch {
        /* fall back to plain text */
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key, code, lang, enabled]);
  if (!enabled) return null;
  return highlightCache.get(key) ?? (result?.key === key ? result.html : null);
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={`flex items-center gap-1 ${className}`}
      aria-label={label}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

function CodeBlock({ code, lang, streaming }: { code: string; lang: string; streaming: boolean }) {
  const html = useHighlighted(code, lang, !streaming);
  return (
    <div className="my-4 overflow-hidden rounded-2xl border border-border bg-[var(--code-bg)]">
      <div className="flex items-center justify-between px-4 py-2 text-xs text-muted">
        <span>{lang || "text"}</span>
        <CopyButton text={code} label="Copy code" className="hover:text-fg" />
      </div>
      {html ? (
        <div className="overflow-x-auto px-4 pb-4 text-[13px] leading-6 [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-x-auto px-4 pb-4 font-mono text-[13px] leading-6">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function makeComponents(streaming: boolean): Components {
  return {
    code({ className, children, ...props }) {
      const match = /language-([\w+#-]+)/.exec(className ?? "");
      const text = String(children ?? "");
      const isBlock = !!match || text.includes("\n");
      if (!isBlock) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }
      return <CodeBlock code={text.replace(/\n$/, "")} lang={match?.[1] ?? ""} streaming={streaming} />;
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ children, href, ...props }) {
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
          {children}
        </a>
      );
    },
    table({ children }) {
      return (
        <div className="my-4 overflow-x-auto">
          <table>{children}</table>
        </div>
      );
    },
  };
}

const staticComponents = makeComponents(false);
const streamingComponents = makeComponents(true);

export const Markdown = memo(function Markdown({ text, streaming = false, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div className={className ? `markdown ${className}` : "markdown"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[rehypeKatex]}
        components={streaming ? streamingComponents : staticComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
