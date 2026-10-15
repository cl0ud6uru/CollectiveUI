export function toolDoneLabel(name: string, output: unknown, fallback: string): string {
  if (name !== "forget" || !output || typeof output !== "object") return fallback;
  return (output as { deleted?: unknown }).deleted === false ? "Memory unchanged" : fallback;
}
