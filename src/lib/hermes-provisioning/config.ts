import { z } from "zod";

export const HERMES_PROTOCOL = "dashboard-be5e9f72-multiplexer-v1";
export const PROVIDER_ENV = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
export const secret = z.string().min(16).max(8192).refine((v) => !/[\r\n]/.test(v), "Secrets must be single-line values");
/** Only exact loopback destinations. No DNS, redirects or URL credentials. */
export const loopbackUrl = z.string().refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" && u.hostname === "127.0.0.1" && !!u.port && Number(u.port) >= 1024 &&
      !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash && v === u.origin;
  } catch { return false; }
}, "Use an exact http://127.0.0.1:<port> origin (port 1024 or higher)");

export const connectionInput = z.object({
  userId: z.string().min(1).max(128),
  boundaryId: z.string().trim().min(3).max(200),
  isolated: z.literal(true),
  protocol: z.literal(HERMES_PROTOCOL),
  dashboardUrl: loopbackUrl,
  runsUrl: loopbackUrl,
  expectedVersion: z.string().min(1).max(100),
  expectedDisplayVersion: z.string().min(1).max(150),
  dashboardToken: secret,
  provider: z.enum(["openai", "anthropic", "openrouter"]),
  providerKey: secret,
  profileKeys: z.array(secret).min(1).max(100).refine((v) => new Set(v).size === v.length, "Profile keys must be distinct"),
}).strict().refine((v) => v.dashboardUrl !== v.runsUrl, "Dashboard and Runs require separate listeners")
  .refine((v) => v.dashboardToken !== v.providerKey && !v.profileKeys.includes(v.dashboardToken) && !v.profileKeys.includes(v.providerKey), "Use distinct credentials for each surface");

export const managedConfig = z.object({
  provider: z.enum(["openai", "anthropic", "openrouter"]),
  model: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/),
  // An explicit empty set; no default seeding, cloning or asynchronous hub installs in this contract.
  skills: z.array(z.never()).length(0),
  toolsets: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(40).refine((v) => new Set(v).size === v.length, "Choose each toolset once"),
}).strict();
export type ManagedConfig = z.infer<typeof managedConfig>;
export type ConnectionSecrets = { dashboardToken: string; providerKey: string; profileKeys: string[] };
export const connectionAAD = (id: string) => `hermes_connections.secret_enc|${id}`;
export const isManagedHermes = (app: { provider: string; providerConfig: Record<string, unknown> }) =>
  app.provider === "hermes" && app.providerConfig.managed !== undefined;
