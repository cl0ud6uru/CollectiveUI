/** Provider source metadata is untrusted. A bad citation must not prevent the rest of a reply from rendering. */
export function SourceLink({ url, title }: { url: string; title?: string }) {
  let parsed: URL | undefined;
  try {
    const candidate = new URL(url);
    if (candidate.protocol === "https:" || candidate.protocol === "http:") parsed = candidate;
  } catch { /* Render an inert label below. */ }
  const className = "mr-2 inline-flex rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted";
  if (!parsed) return <span className={className}>{title || "Unavailable source"}</span>;
  return <a href={parsed.href} target="_blank" rel="noreferrer noopener" className={`${className} hover:text-fg`}>{title ?? parsed.hostname}</a>;
}
