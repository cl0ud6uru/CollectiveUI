import { z } from "zod";
import type { SandboxSettings } from "@/lib/settings";

export type SetupCheck = { id: string; label: string; state: "pass" | "fail" | "pending"; detail: string };
/** Only fixed messages and booleans cross the admin/browser boundary. Never include raw daemon output or env values. */
export type WorkspaceSetupReport = { ready: boolean; checkedAt: string; checks: SetupCheck[]; hasWarnings: boolean };

// Validate the readiness fields rather than trusting the daemon's TypeScript wire type.
const healthSchema = z.object({
  ok: z.boolean(),
  docker: z.object({ version: z.string(), apiVersion: z.string() }).nullable(),
  image: z.object({ present: z.boolean() }),
  gvisor: z.object({ available: z.boolean() }),
  defaultRuntime: z.enum(["runsc", "runc"]).nullable(),
  warnings: z.array(z.string()),
});

export type SetupConfigState = "configured" | "missing_url" | "missing_secret" | "invalid";
export function workspaceConfigState(env: Record<string, string | undefined>): SetupConfigState {
  if (!env.SANDBOXD_URL?.trim()) return "missing_url";
  if (!env.SANDBOXD_SECRET?.trim()) return "missing_secret";
  try {
    const url = new URL(env.SANDBOXD_URL);
    if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      new TextEncoder().encode(env.SANDBOXD_SECRET).length < 32) return "invalid";
    return "configured";
  } catch { return "invalid"; }
}

export function workspaceSetupReport({ config, health, errorCode, allowRunc, checkedAt = new Date().toISOString() }: {
  config: SetupConfigState; health?: unknown; errorCode?: string; allowRunc: SandboxSettings["allowRunc"]; checkedAt?: string;
}): WorkspaceSetupReport {
  const configDetail = {
    configured: "Portal connection settings are present. Values stay on the server.",
    missing_url: "Set SANDBOXD_URL and the shared SANDBOXD_SECRET for both web and worker, then recreate those services.",
    missing_secret: "Set the same SANDBOXD_SECRET for web, worker and sandboxd, then recreate the services.",
    invalid: "Use an http:// host:port URL on the private control network, with no credentials, path or query. The shared secret must be at least 32 bytes. Recreate web and worker after correcting their environment.",
  }[config];
  const checks: SetupCheck[] = [{ id: "configuration", label: "Portal configuration", state: config === "configured" ? "pass" : "fail", detail: configDetail }];
  const parsed = healthSchema.safeParse(health);
  const h = config === "configured" && !errorCode && parsed.success ? parsed.data : null;
  const serviceDetail = errorCode === "unauthorized"
    ? "Authentication failed. Match the shared secret on web, worker and sandboxd and check their clocks, then recreate the services and retry."
    : errorCode === "timeout"
      ? "The service timed out. Check sandboxd locally and the private control network, then retry."
      : "The service could not be checked. Check sandboxd is running and reachable from web on the private control network, then retry.";
  checks.push({ id: "service", label: "Authenticated service connection", state: h ? "pass" : config === "configured" ? "fail" : "pending",
    detail: h ? "The portal received a valid health response to an authenticated request." : config === "configured" ? serviceDetail : "Waiting for portal configuration." });
  checks.push({ id: "docker", label: "Docker and service readiness", state: h ? h.ok && h.docker ? "pass" : "fail" : "pending",
    detail: h ? h.ok && h.docker ? "sandboxd reports Docker and its service checks are ready." : "Docker or a service prerequisite is not ready. Run the host checks below and inspect sandboxd locally." : "Waiting for a service response." });
  checks.push({ id: "image", label: "Workspace image", state: h ? h.image.present ? "pass" : "fail" : "pending",
    detail: h ? h.image.present ? "The configured workspace image is installed on the Docker host." : "Build the configured workspace image on the Docker host with npm run sandbox:image, then retry." : "Waiting for a service response." });
  const isolationReady = !!h && ((h.gvisor.available && h.defaultRuntime === "runsc") || (allowRunc && h.defaultRuntime === "runc"));
  checks.push({ id: "isolation", label: "Isolation policy", state: h ? isolationReady ? "pass" : "fail" : "pending",
    detail: h ? h.gvisor.available && h.defaultRuntime === "runsc" ? "gVisor is available for workspace isolation." : isolationReady
      ? "Standard isolation is allowed by a saved admin acknowledgement. Commands share the host kernel."
      : h.gvisor.available ? "The service reported inconsistent isolation readiness. Inspect sandboxd's local --check output, correct its runtime configuration and retry."
      : "gVisor is unavailable. Ask the Docker host operator to install and verify runsc. Standard isolation requires a separate admin acknowledgement; setup never turns it on."
      : "Waiting for a service response." });
  return { ready: checks.every(c => c.state === "pass"), checkedAt, checks, hasWarnings: !!h?.warnings.length };
}
