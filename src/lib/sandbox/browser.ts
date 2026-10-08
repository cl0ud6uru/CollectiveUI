import { artifactPath } from "@/lib/chat/workspace-artifacts";

export const PREVIEW_BYTES = 256 * 1024;
export type WorkspaceBrowserStatus = {
  allowed: boolean; configured: boolean; state: "running" | "stopped" | "missing" | "unavailable";
  runtime: "runsc" | "runc" | null;
};
export type WorkspaceFilePreview = { path: string; text: string | null; size: number; truncated: boolean; binary: boolean };

/** Browser paths are relative to the owner's workspace, never a container/host path or ref. */
export function browserPath(value: unknown, root = false): string | null {
  if (root && (value === undefined || value === null || value === "" || value === ".")) return ".";
  return artifactPath(value);
}

export function previewFile(path: string, file: { bytes: Uint8Array; size: number; truncated: boolean }): WorkspaceFilePreview {
  let text: string | null = null;
  if (!file.bytes.subarray(0, 8192).includes(0)) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes, { stream: file.truncated }); }
    catch { /* Non UTF-8 content is downloadable, never executed in a preview. */ }
  }
  return { path, text, size: file.size, truncated: file.truncated, binary: text === null };
}
