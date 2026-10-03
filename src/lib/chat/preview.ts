/** One line for the sidebar: collapsed whitespace, markdown punctuation dropped, capped. */
export function previewLine(text: string, max = 80): string | null {
  const line = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>|]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
