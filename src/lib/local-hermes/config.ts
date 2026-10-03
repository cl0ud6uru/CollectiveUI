import { isDockerHermes } from "@/lib/docker-hermes/policy";
import { bindingSchema } from "@/docker-hermes/types";
import { z } from "zod";

export const LocalBindingConfig = z.object({ runtimeId: z.string().regex(/^[a-f0-9]{64}$/), bindingId: z.string().regex(/^[a-f0-9]{32}$/),
  ownerId: z.string().min(1), botId: z.string().min(1), model: z.string(), provider: z.string() }).strict();
export const isLocalHermes = (app: { provider: string; providerConfig: Record<string, unknown> }) =>
  app.provider === "hermes" && (app.providerConfig.local !== undefined || isDockerHermes(app));
export const localBinding = (app: { providerConfig: Record<string, unknown> }) => {
  if (app.providerConfig.docker !== undefined) {
    const b = bindingSchema.parse(app.providerConfig.docker);
    return { runtimeId: b.runtimeId, bindingId: b.bindingId, ownerId: b.ownerId, botId: b.botId, model: "", provider: "" };
  }
  return LocalBindingConfig.parse(app.providerConfig.local);
};
