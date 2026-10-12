/** Public artifact paths never contain a sandbox ref or a server filesystem path. */
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export function artifactPath(value: unknown, normalize = false): string | null {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)) return null;
  const path = value.startsWith("/home/agent/workspace/") ? value.slice("/home/agent/workspace/".length) : value;
  if (path.startsWith("/") || /^[a-z]:/i.test(path)) return null;
  const segments = path.split("/");
  if (normalize) {
    const canonical: string[] = [];
    for (const segment of segments) {
      if (!segment || segment === ".") continue;
      if (segment === "..") { if (!canonical.length) return null; canonical.pop(); }
      else canonical.push(segment);
    }
    return artifactPath(canonical.join("/"));
  }
  if (segments.some((s) => !s || s === "." || s === "..")) return null;
  return path;
}

const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function artifactLink(path: unknown, instanceId?: unknown): { downloadUrl: string; instanceId?: string } | Record<string, never> {
  const safe = artifactPath(path, true);
  if (!safe) return {};
  const selectedInstance = typeof instanceId === "string" && INSTANCE_ID_RE.test(instanceId) ? instanceId : undefined;
  const selector = selectedInstance ? `&instanceId=${encodeURIComponent(selectedInstance)}` : "";
  return { downloadUrl: `/api/workspace/files?path=${encodeURIComponent(safe)}${selector}`, ...(selectedInstance ? { instanceId: selectedInstance } : {}) };
}

/** Ignore model-provided URLs: UI actions derive their route from a successful, known file tool result. */
export function workspaceArtifact(name: string, output: unknown): { path: string; downloadUrl: string } | null {
  if (!["workspace_write", "workspace_edit", "workspace_read"].includes(name) || !output || typeof output !== "object") return null;
  const result = output as { ok?: unknown; path?: unknown; instanceId?: unknown };
  const path = result.ok === true ? artifactPath(result.path, true) : null;
  return path ? { path, ...artifactLink(path, result.instanceId) } as { path: string; downloadUrl: string } : null;
}
